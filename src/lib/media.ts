/**
 * Runtime media registry, probing, decoding, derived caches, and frame capture.
 *
 * IndexedDB is the durable source for asset bytes. In-memory metadata, blobs, object URLs, decoded
 * images, thumbnails, and waveforms reduce repeated I/O, while a serial decode queue avoids multiple
 * expensive jobs on constrained phones. WebCodecs paths fall back to media elements/Web Audio when
 * a codec or container is not supported.
 */
import { ALL_FORMATS, AudioBufferSink, BlobSource, CanvasSink, Input } from 'mediabunny';
import type { MediaAsset, MediaKind } from '../types';
import { getMedia, getPeaks, getThumbs, putMedia, putPeaks, putThumbs, type PeakRecord } from './db';
import { clamp, uid } from './util';

/** Fires `update` with `detail = assetId` whenever thumbnails or waveforms become available. */
export const mediaEvents = new EventTarget();

/** Session metadata cache, keyed by stable asset ID. */
const assets = new Map<string, MediaAsset>();
/** Session source-blob cache used to avoid repeated IndexedDB reads. */
const blobs = new Map<string, Blob>();
/** Session object-URL cache; URLs stay private to the current origin and process. */
const urls = new Map<string, string>();

/** Registers metadata and optional bytes for fast synchronous/deduplicated later lookups. */
export function registerAsset(asset: MediaAsset, blob?: Blob) {
  assets.set(asset.id, asset);
  if (blob) blobs.set(asset.id, blob);
}

/** Returns cached metadata without performing persistence or network I/O. */
export function getAsset(id: string): MediaAsset | undefined {
  return assets.get(id);
}

/**
 * Loads missing records from IndexedDB for a list of IDs.
 * Results omit records that no longer exist and reuse session-cached metadata where possible.
 */
export async function loadAssets(ids: string[]): Promise<Record<string, MediaAsset>> {
  const out: Record<string, MediaAsset> = {};
  for (const id of ids) {
    let a = assets.get(id);
    if (!a) {
      const rec = await getMedia(id);
      if (rec) {
        registerAsset(rec.asset, rec.blob);
        a = rec.asset;
      }
    }
    if (a) out[id] = a;
  }
  return out;
}

/**
 * Resolves a source blob from memory or IndexedDB.
 * A missing/deleted ID returns `null`; successful disk reads populate both session caches.
 */
export async function getBlob(id: string): Promise<Blob | null> {
  const b = blobs.get(id);
  if (b) return b;
  const rec = await getMedia(id);
  if (!rec) return null;
  registerAsset(rec.asset, rec.blob);
  return rec.blob;
}

/**
 * Gets or creates the stable session object URL for a source blob.
 * This never uploads data; a missing media ID resolves to `null`.
 */
export async function getObjectUrl(id: string): Promise<string | null> {
  const u = urls.get(id);
  if (u) return u;
  const b = await getBlob(id);
  if (!b) return null;
  const existing = urls.get(id);
  if (existing) return existing;
  const url = URL.createObjectURL(b);
  urls.set(id, url);
  return url;
}

/** Synchronous variant: returns null (and starts loading) when the blob is not in memory yet. */
export function peekObjectUrl(id: string): string | null {
  const u = urls.get(id);
  if (u) return u;
  const b = blobs.get(id);
  if (!b) {
    void getObjectUrl(id).then((url) => {
      if (url) mediaEvents.dispatchEvent(new CustomEvent('update', { detail: id }));
    });
    return null;
  }
  const url = URL.createObjectURL(b);
  urls.set(id, url);
  return url;
}

/**
 * Infers a supported media kind from MIME type, then from the filename extension when needed.
 * Unknown media returns `null` for the import caller to turn into a user-facing error.
 */
export function kindOf(type: string, name: string): MediaKind | null {
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/')) return 'audio';
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['mp4', 'mov', 'm4v', 'webm', 'mkv', '3gp', 'ts', 'mts', 'avi'].includes(ext)) return 'video';
  if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'bmp'].includes(ext)) return 'image';
  if (['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'opus', 'flac', 'caf', 'weba'].includes(ext)) return 'audio';
  return null;
}

/** Codec/container facts normalized by the Mediabunny and HTML-element probing paths. */
interface ProbeInfo {
  duration: number;
  width: number;
  height: number;
  hasVideo: boolean;
  hasAudio: boolean;
  canDecodeVideo: boolean;
  canDecodeAudio: boolean;
}

/**
 * Probes tracks and duration with Mediabunny and reports WebCodecs decode capability.
 * The parser is disposed after success or failure.
 */
async function probeMediabunny(blob: Blob): Promise<ProbeInfo> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  try {
    const v = await input.getPrimaryVideoTrack();
    const a = await input.getPrimaryAudioTrack();
    if (!v && !a) throw new Error('no tracks');
    const duration = await input.computeDuration();
    return {
      duration,
      width: v ? await v.getDisplayWidth() : 0,
      height: v ? await v.getDisplayHeight() : 0,
      hasVideo: !!v,
      hasAudio: !!a,
      canDecodeVideo: v ? await v.canDecode().catch(() => false) : false,
      canDecodeAudio: a ? await a.canDecode().catch(() => false) : false,
    };
  } finally {
    input.dispose();
  }
}

/**
 * Fallback metadata probe using a muted audio/video element and a temporary object URL.
 * It reports conservative decode flags; loading or codec errors reject as unsupported media.
 */
function probeElement(blob: Blob, kind: MediaKind): Promise<ProbeInfo> {
  return new Promise((resolve, reject) => {
    const el = document.createElement(kind === 'audio' ? 'audio' : 'video') as HTMLVideoElement;
    const url = URL.createObjectURL(blob);
    el.preload = 'metadata';
    el.muted = true;
    const done = () => URL.revokeObjectURL(url);
    el.onloadedmetadata = () => {
      const duration = el.duration;
      resolve({
        duration: Number.isFinite(duration) ? duration : 0,
        width: el.videoWidth || 0,
        height: el.videoHeight || 0,
        hasVideo: kind === 'video' && el.videoWidth > 0,
        hasAudio: true,
        canDecodeVideo: false,
        canDecodeAudio: false,
      });
      done();
    };
    el.onerror = () => {
      done();
      reject(new Error('This file format is not supported on this device'));
    };
    el.src = url;
  });
}

/**
 * Creates durable metadata from a local blob without modifying its bytes.
 *
 * Images use `ImageBitmap`; timed media tries Mediabunny first and an HTML media element second.
 * Unsupported kinds, undecodable images, and zero-duration timed media reject with UI-ready errors.
 */
export async function probe(blob: Blob, name: string, type: string): Promise<MediaAsset> {
  const kind = kindOf(type, name);
  if (!kind) throw new Error('Unsupported file type');
  const base = { id: uid('m_'), name, mime: type, size: blob.size, createdAt: Date.now() };
  if (kind === 'image') {
    const bmp = await createImageBitmap(blob).catch(() => {
      throw new Error('This image format is not supported on this device');
    });
    const asset: MediaAsset = {
      ...base,
      kind,
      duration: 0,
      width: bmp.width,
      height: bmp.height,
      hasAudio: false,
      canDecodeVideo: false,
      canDecodeAudio: false,
    };
    bmp.close();
    return asset;
  }
  let info: ProbeInfo;
  try {
    info = await probeMediabunny(blob);
  } catch {
    info = await probeElement(blob, kind);
  }
  if (!(info.duration > 0)) throw new Error('Could not read the media duration');
  const finalKind: MediaKind = info.hasVideo ? 'video' : 'audio';
  if (kind === 'video' && !info.hasVideo && !info.hasAudio) throw new Error('No playable tracks found');
  return {
    ...base,
    kind: finalKind,
    duration: info.duration,
    width: info.width,
    height: info.height,
    hasAudio: info.hasAudio,
    canDecodeVideo: info.canDecodeVideo,
    canDecodeAudio: info.canDecodeAudio,
  };
}

/**
 * Sequentially probes, persists, and registers a batch of local files.
 *
 * One bad file does not abort the remaining imports. Successful assets schedule thumbnail and
 * waveform work in the background, while `errors` preserves each source filename and reason.
 */
export async function importFiles(
  files: File[] | Blob[],
  onProgress?: (done: number, total: number, name: string) => void,
): Promise<{ assets: MediaAsset[]; errors: string[] }> {
  const out: MediaAsset[] = [];
  const errors: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const name = (f as File).name ?? `media-${i + 1}`;
    onProgress?.(i, files.length, name);
    try {
      const asset = await probe(f, name, f.type);
      await putMedia(asset, f);
      registerAsset(asset, f);
      out.push(asset);
      void ensureThumbs(asset.id);
      if (asset.hasAudio) void ensurePeaks(asset.id);
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`);
    }
  }
  onProgress?.(files.length, files.length, '');
  return { assets: out, errors };
}

// ---------------------------------------------------------------------------
// Background work queue (one decode job at a time keeps phones responsive)

/** Tail of the one-at-a-time decode queue; failures are recorded then the queue remains usable. */
let queue: Promise<unknown> = Promise.resolve();

/** Runs an expensive job after prior decode work while allowing subsequent work after rejection. */
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
}

// ---------------------------------------------------------------------------
// Canvas helpers

/** Allocates an on-page canvas with the requested explicit pixel dimensions. */
export function makeCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/**
 * Encodes an HTML or Offscreen canvas as a blob.
 * Offscreen conversion is direct; a null `toBlob` result becomes a rejected promise.
 */
export function canvasToBlob(c: HTMLCanvasElement | OffscreenCanvas, type = 'image/jpeg', q = 0.75): Promise<Blob> {
  if ('convertToBlob' in c) return c.convertToBlob({ type, quality: q });
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), type, q));
}

/** Draws a source with centered CSS-style cover behavior into a square thumbnail canvas. */
function drawCover(ctx: CanvasRenderingContext2D, src: CanvasImageSource, sw: number, sh: number, size: number) {
  const s = Math.max(size / sw, size / sh);
  const w = sw * s;
  const h = sh * s;
  ctx.drawImage(src, (size - w) / 2, (size - h) / 2, w, h);
}

/**
 * Loads a muted/inlined HTML video far enough to decode frames, resolving after data or an 8s cap.
 *
 * A play/pause probe helps metadata-only browser implementations. Errors reject, and callers own
 * cleanup of the URL and element when finished.
 */
export function loadVideoElement(url: string): Promise<HTMLVideoElement> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.preload = 'auto';
    v.crossOrigin = 'anonymous';
    const timer = setTimeout(() => resolve(v), 8000);
    v.onloadeddata = () => {
      clearTimeout(timer);
      resolve(v);
    };
    v.onloadedmetadata = () => {
      if (v.readyState < 2) {
        v.play()
          .then(() => v.pause())
          .catch(() => undefined);
      }
    };
    v.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Video failed to load'));
    };
    v.src = url;
    v.load();
  });
}

/**
 * Seeks a loaded media element, resolving on `seeked` or after a 3s best-effort timeout.
 * Already-ready near-identical times return immediately.
 */
export function seekElement(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise((resolve) => {
    if (Math.abs(v.currentTime - t) < 0.001 && v.readyState >= 2) return resolve();
    const timer = setTimeout(finish, 3000);
    function finish() {
      clearTimeout(timer);
      v.removeEventListener('seeked', finish);
      resolve();
    }
    v.addEventListener('seeked', finish);
    v.currentTime = t;
  });
}

// ---------------------------------------------------------------------------
// Images

/** Decoded image representation retained for renderer texture upload. */
type DecodedImage = ImageBitmap | HTMLCanvasElement;
/** In-flight decoded-image jobs, allowing simultaneous consumers to share one decode. */
const imageCache = new Map<string, Promise<DecodedImage>>();
/** Successfully decoded images, used by synchronous renderer peeks. */
const imageValues = new Map<string, DecodedImage>();
/** Conservative maximum dimension used when downsizing images for GPU compatibility. */
const MAX_IMAGE = 4096;

/**
 * Decodes and caches an image by media ID.
 *
 * Premultiplied alpha is requested for WebGL consistency. Images larger than 4096 are downscaled
 * to a canvas, and failures are removed from the promise cache so a later call can retry.
 */
export function getImage(id: string): Promise<DecodedImage> {
  let p = imageCache.get(id);
  if (!p) {
    p = (async () => {
      const blob = await getBlob(id);
      if (!blob) throw new Error('Missing image');
      // WebGL ignores UNPACK_PREMULTIPLY_ALPHA for ImageBitmaps, so request premultiplied pixels up front.
      const bmp = await createImageBitmap(blob, { premultiplyAlpha: 'premultiply' }).catch(() => createImageBitmap(blob));
      const big = Math.max(bmp.width, bmp.height);
      let out: DecodedImage = bmp;
      if (big > MAX_IMAGE) {
        const s = MAX_IMAGE / big;
        const c = makeCanvas(Math.round(bmp.width * s), Math.round(bmp.height * s));
        c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
        bmp.close();
        out = c;
      }
      imageValues.set(id, out);
      mediaEvents.dispatchEvent(new CustomEvent('update', { detail: id }));
      return out;
    })();
    imageCache.set(id, p);
    p.catch(() => imageCache.delete(id));
  }
  return p;
}

/** Returns the decoded image if ready, otherwise starts loading it and returns null. */
export function peekImage(id: string): DecodedImage | null {
  const v = imageValues.get(id);
  if (v) return v;
  void getImage(id).catch(() => undefined);
  return null;
}

// ---------------------------------------------------------------------------
// Thumbnails

/** In-memory timeline thumbnail set and its real-time spacing. */
export interface ThumbStrip {
  interval: number;
  images: (ImageBitmap | null)[];
}

/** Pixel edge of each cover-cropped timeline thumbnail. */
const THUMB = 96;
/** Decoded thumbnail strips ready for synchronous UI reads. */
const thumbMem = new Map<string, ThumbStrip>();
/** One in-flight/persisted-thumbnail job per media ID. */
const thumbJobs = new Map<string, Promise<void>>();

/** Returns a decoded thumbnail strip if generation/loading has completed. */
export function getThumbStrip(id: string): ThumbStrip | null {
  return thumbMem.get(id) ?? null;
}

/**
 * Loads or generates and persists the thumbnail strip for a visual asset.
 *
 * IndexedDB is checked first. New jobs use the serial queue, and individual corrupt thumbnail
 * frames decode to `null` rather than discarding the whole strip. Background failures only warn.
 */
export function ensureThumbs(id: string): Promise<void> {
  let job = thumbJobs.get(id);
  if (!job) {
    job = (async () => {
      let rec = await getThumbs(id);
      if (!rec) {
        const asset = assets.get(id) ?? (await loadAssets([id]))[id];
        const blob = await getBlob(id);
        if (!asset || !blob || asset.kind === 'audio') return;
        rec = await enqueue(() => generateThumbs(asset, blob));
        await putThumbs(rec);
      }
      const images = await Promise.all(rec.blobs.map((b) => createImageBitmap(b).catch(() => null)));
      thumbMem.set(id, { interval: rec.interval, images });
      mediaEvents.dispatchEvent(new CustomEvent('update', { detail: id }));
    })().catch((e) => console.warn('thumbs failed', e));
    thumbJobs.set(id, job);
  }
  return job;
}

/**
 * Generates an evenly sampled, cover-cropped strip for an image or video.
 *
 * Images produce one long-interval frame. Videos prefer WebCodecs CanvasSink and fall back to
 * element seeking. Temporary URLs/parsers are cleaned up in `finally` blocks.
 */
async function generateThumbs(asset: MediaAsset, blob: Blob) {
  const c = makeCanvas(THUMB, THUMB);
  const ctx = c.getContext('2d')!;
  if (asset.kind === 'image') {
    const bmp = await createImageBitmap(blob);
    drawCover(ctx, bmp, bmp.width, bmp.height, THUMB);
    bmp.close();
    return { id: asset.id, interval: 1e9, blobs: [await canvasToBlob(c)] };
  }
  const interval = clamp(asset.duration / 120, 0.5, 5);
  const n = Math.max(1, Math.ceil(asset.duration / interval));
  const times = Array.from({ length: n }, (_, i) => Math.min(Math.max(0, asset.duration - 0.05), i * interval + 0.02));
  const out: Blob[] = [];
  if (asset.canDecodeVideo) {
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (!track) throw new Error('no video');
      const sink = new CanvasSink(track, { width: THUMB, height: THUMB, fit: 'cover', poolSize: 2 });
      let last: Blob | null = null;
      for await (const wc of sink.canvasesAtTimestamps(times)) {
        if (wc) last = await canvasToBlob(wc.canvas);
        if (last) out.push(last);
      }
      if (out.length) return { id: asset.id, interval, blobs: out };
    } catch (e) {
      console.warn('WebCodecs thumbnails failed, using <video>', e);
    } finally {
      input.dispose();
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const v = await loadVideoElement(url);
    for (const t of times) {
      await seekElement(v, t);
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, THUMB, THUMB);
      drawCover(ctx, v, v.videoWidth || THUMB, v.videoHeight || THUMB, THUMB);
      out.push(await canvasToBlob(c));
    }
    v.removeAttribute('src');
    v.load();
  } finally {
    URL.revokeObjectURL(url);
  }
  return { id: asset.id, interval, blobs: out };
}

// ---------------------------------------------------------------------------
// Waveform peaks

/** Waveform samples retained per second of source audio. */
export const PEAK_RATE = 50;
/** Completed waveform records available to synchronous timeline rendering. */
const peakMem = new Map<string, PeakRecord>();
/** One waveform load/generation job per source asset. */
const peakJobs = new Map<string, Promise<void>>();

/** Returns the cached waveform record if it has finished loading or generation. */
export function getPeaksSync(id: string): PeakRecord | null {
  return peakMem.get(id) ?? null;
}

/**
 * Loads or computes persistent normalized waveform data for an audio-bearing asset.
 *
 * Derived records are stored in IndexedDB after generation, and completion emits a `mediaEvents`
 * update. Failures warn and remain best-effort so media remains usable without a waveform.
 */
export function ensurePeaks(id: string): Promise<void> {
  let job = peakJobs.get(id);
  if (!job) {
    job = (async () => {
      let rec = await getPeaks(id);
      if (!rec) {
        const asset = assets.get(id) ?? (await loadAssets([id]))[id];
        const blob = await getBlob(id);
        if (!asset || !blob || !asset.hasAudio) return;
        rec = await enqueue(() => generatePeaks(asset, blob));
        await putPeaks(rec);
      }
      peakMem.set(id, rec);
      mediaEvents.dispatchEvent(new CustomEvent('update', { detail: id }));
    })().catch((e) => console.warn('peaks failed', e));
    peakJobs.set(id, job);
  }
  return job;
}

/**
 * Adds absolute samples from an AudioBuffer to 50 Hz peak bins.
 *
 * Stereo is represented by the maximum of the first two channels; every third sample is inspected
 * as a bounded CPU-saving approximation. Later buffers update only bins later in time.
 */
function accumulate(data: Float32Array, buf: AudioBuffer, timestamp: number) {
  const ch0 = buf.getChannelData(0);
  const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
  const base = timestamp * PEAK_RATE;
  const step = PEAK_RATE / buf.sampleRate;
  for (let i = 0; i < ch0.length; i += 3) {
    let v = Math.abs(ch0[i]);
    if (ch1) v = Math.max(v, Math.abs(ch1[i]));
    const k = Math.floor(base + i * step);
    if (k >= 0 && k < data.length && v > data[k]) data[k] = v;
  }
}

/**
 * Generates a normalized byte waveform from audio samples.
 *
 * WebCodecs/Mediabunny streaming decode is preferred, with full Web Audio decoding as fallback.
 * Square-root normalization is applied after global peak scaling for useful visual dynamics.
 */
async function generatePeaks(asset: MediaAsset, blob: Blob): Promise<PeakRecord> {
  const data = new Float32Array(Math.ceil(asset.duration * PEAK_RATE) + 1);
  let ok = false;
  if (asset.canDecodeAudio) {
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
    try {
      const track = await input.getPrimaryAudioTrack();
      if (track) {
        const sink = new AudioBufferSink(track);
        for await (const { buffer, timestamp } of sink.buffers()) accumulate(data, buffer, timestamp);
        ok = true;
      }
    } catch (e) {
      console.warn('WebCodecs audio decode failed, falling back', e);
    } finally {
      input.dispose();
    }
  }
  if (!ok) {
    const buf = await decodeWholeAudio(blob);
    accumulate(data, buf, 0);
  }
  let max = 0;
  for (const v of data) max = Math.max(max, v);
  const norm = max > 0 ? 1 / max : 1;
  const u8 = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) u8[i] = Math.round(Math.sqrt(data[i] * norm) * 255);
  return { id: asset.id, rate: PEAK_RATE, data: u8 };
}

/**
 * Decodes a complete audio/video blob into PCM with the browser's offline Web Audio API.
 *
 * This compatibility fallback loads the whole file into memory and supports both the standard and
 * older prefixed iOS context. Decode errors reject to the derived-cache caller.
 */
export async function decodeWholeAudio(blob: Blob): Promise<AudioBuffer> {
  const ab = await blob.arrayBuffer();
  const Ctx = window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const ctx = new Ctx(2, 1, 48000);
  return await new Promise<AudioBuffer>((resolve, reject) => {
    const p = ctx.decodeAudioData(ab, resolve, reject);
    if (p && typeof p.then === 'function') p.then(resolve, reject);
  });
}

// ---------------------------------------------------------------------------
// Frame capture (freeze frame / save still)

/**
 * Captures an exact/near-exact video frame as a high-quality JPEG blob.
 *
 * WebCodecs is tried first for predictable frame selection, then the HTML video element handles
 * unsupported codecs or paths. Missing media throws and no file is persisted by this function.
 */
export async function captureFrame(asset: MediaAsset, t: number): Promise<Blob> {
  const blob = await getBlob(asset.id);
  if (!blob) throw new Error('Missing media');
  if (asset.canDecodeVideo) {
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
    try {
      const track = await input.getPrimaryVideoTrack();
      if (track) {
        const sink = new CanvasSink(track);
        const wc = (await sink.getCanvas(t)) ?? (await sink.getCanvas(Math.max(0, t - 0.1)));
        if (wc) return await canvasToBlob(wc.canvas, 'image/jpeg', 0.92);
      }
    } finally {
      input.dispose();
    }
  }
  const url = await getObjectUrl(asset.id);
  const v = await loadVideoElement(url!);
  await seekElement(v, t);
  const c = makeCanvas(v.videoWidth, v.videoHeight);
  c.getContext('2d')!.drawImage(v, 0, 0);
  return canvasToBlob(c, 'image/jpeg', 0.92);
}
