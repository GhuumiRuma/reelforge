/**
 * Deterministic offline renderer/exporter. It owns a cloned project snapshot,
 * exact-frame providers, audio mixing, WebGL composition, and in-memory MP4
 * encoding, while live preview remains isolated from encoder/timeline state.
 */
import {
  ALL_FORMATS,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  Quality,
  canEncodeAudio,
  getFirstEncodableVideoCodec,
  type AudioCodec,
  type VideoCodec,
  type WrappedCanvas,
} from 'mediabunny';
import type { ImageItem, Project, VideoItem } from '../types';
import { readBackgroundRemoval } from '../lib/background';
import { acquireWakeLock } from '../lib/device';
import { canvasSize, projectDuration } from '../lib/layout';
import { getAsset, getBlob, getImage, getObjectUrl, loadAssets, loadVideoElement, makeCanvas, peekImage, seekElement } from '../lib/media';
import { ensureFont } from '../lib/text';
import { clamp, safeFileName } from '../lib/util';
import { AudioMixer, canEncodeAac } from './audio';
import { subjectMatte, subjectMatteKey, type BackgroundStatus } from './background';
import { Compositor } from './gl';
import { buildFrame, TextCache, type FrameProvider, type FrameSource } from './scene';

/** Supported short-side output resolutions, in pixels. */
export type ExportResolution = 720 | 1080 | 1440 | 2160;
/** User-facing quality presets mapped to a bounded bits-per-pixel heuristic. */
export type ExportQuality = 'low' | 'medium' | 'high';

/** Encoder dimensions/rate settings captured at the start of an export. */
export interface ExportSettings {
  resolution: ExportResolution;
  fps: number;
  quality: ExportQuality;
}

/** Monotonic phase-local progress plus an optional wall-clock ETA estimate. */
export interface ExportProgress {
  phase: 'prepare' | 'cutout' | 'render' | 'finalize';
  /** 0..1 */
  progress: number;
  /** seconds remaining, when known */
  eta: number | null;
}

/** Completed MP4 bytes and metadata returned after finalization. */
export interface ExportResult {
  blob: Blob;
  width: number;
  height: number;
  duration: number;
  codec: string;
  fileName: string;
}

const BPP: Record<ExportQuality, number> = { low: 0.06, medium: 0.11, high: 0.18 };
const AUDIO_BITRATE = 192_000;
const SAMPLE_RATE = 48_000;

/** Converts an aspect ratio and requested short side to concrete canvas dimensions. */
export function exportDims(p: Project, s: Pick<ExportSettings, 'resolution'>) {
  return canvasSize(p.aspect, s.resolution);
}

/**
 * Estimates video bits/s from output pixels, frame rate, and quality.
 * The result is clamped to avoid unusable tiny or browser-hostile huge requests.
 */
export function videoBitrate(p: Project, s: ExportSettings): number {
  const { w, h } = exportDims(p, s);
  return Math.round(clamp(w * h * s.fps * BPP[s.quality], 1_000_000, 80_000_000));
}

/**
 * Estimates total MP4 bytes from video bitrate, a fixed audio allowance, and
 * project duration. Container/index overhead and silence are not modeled.
 */
export function estimateSize(p: Project, s: ExportSettings): number {
  return ((videoBitrate(p, s) + AUDIO_BITRATE) / 8) * projectDuration(p);
}

// ---------------------------------------------------------------------------
// Sequential frame sources (exact frames, decoded in order)

/** Sequential source contract used only during one export/still render pass. */
interface SeqSource {
  /** Supplies the last decoded source frame at or before `st` for the caller's scene build. */
  frameAt(st: number): Promise<FrameSource | null>;
  /** Releases this provider's input/iterator/video state before it is discarded. */
  dispose(): void;
}

let exportVersion = 0;

/**
 * WebCodecs/CanvasSink provider for ordered video decoding.
 *
 * It keeps one look-ahead frame and restarts only for backward or large forward
 * seeks, trading a small buffer for much faster frame-by-frame export.
 */
class SinkFrames implements SeqSource {
  private input: Input | null = null;
  private sink: CanvasSink | null = null;
  private iter: AsyncGenerator<WrappedCanvas, void, unknown> | null = null;
  private cur: WrappedCanvas | null = null;
  private next: WrappedCanvas | null = null;
  private done = false;
  private version = 0;

  /** Captures the blob and maximum decoded side without opening demux/codec resources yet. */
  constructor(
    private blob: Blob,
    private maxSide: number,
  ) {}

  /** Opens the primary track and constructs a bounded CanvasSink scaled to `maxSide`. */
  private async open() {
    this.input = new Input({ formats: ALL_FORMATS, source: new BlobSource(this.blob) });
    const track = await this.input.getPrimaryVideoTrack();
    if (!track) throw new Error('No video track');
    const w = await track.getDisplayWidth();
    const h = await track.getDisplayHeight();
    const k = Math.min(1, this.maxSide / Math.max(w, h, 1));
    this.sink = new CanvasSink(track, {
      width: Math.max(2, Math.round(w * k)),
      height: Math.max(2, Math.round(h * k)),
      fit: 'fill',
      poolSize: 4,
    });
  }

  /**
   * Closes the old async iterator and starts decoding at or near `st`.
   * Restarting also resets the look-ahead frame and timestamp state.
   */
  private async restart(st: number) {
    if (!this.sink) await this.open();
    await this.iter?.return();
    this.iter = this.sink!.canvases(st);
    this.cur = null;
    this.next = null;
    this.done = false;
    const r = await this.iter.next();
    if (!r.done) {
      this.cur = r.value;
      this.version = ++exportVersion;
    } else this.done = true;
  }

  /**
   * Returns the most recent decoded frame at or before `st`.
   *
   * The iterator advances only as needed for increasing timestamps, and each
   * accepted canvas gets a process-global version for compositor invalidation.
   */
  async frameAt(st: number): Promise<FrameSource | null> {
    if (!this.iter || (this.cur && st < this.cur.timestamp - 1e-3) || (this.cur && st > this.cur.timestamp + 3)) {
      await this.restart(st);
    }
    while (!this.done) {
      if (!this.next) {
        const r = await this.iter!.next();
        if (r.done) {
          this.done = true;
          break;
        }
        this.next = r.value;
      }
      if (this.next.timestamp <= st + 1e-4 || !this.cur) {
        this.cur = this.next;
        this.next = null;
        this.version = ++exportVersion;
      } else break;
    }
    return this.cur ? { source: this.cur.canvas, version: this.version } : null;
  }

  /** Stops iteration and disposes the demux input, leaving only lazy source inputs for possible reopening. */
  dispose() {
    void this.iter?.return().catch(() => undefined);
    this.iter = null;
    this.input?.dispose();
    this.input = null;
    this.sink = null;
  }
}

/**
 * HTML media-element fallback for codecs WebCodecs cannot decode.
 *
 * Seeking is exact-enough for export ordering but substantially slower than a
 * streaming `CanvasSink`; the current frame is retained in a single scaled
 * canvas and invalidated by version.
 */
class ElementFrames implements SeqSource {
  private v: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private version = 0;
  private last = -1;

  /** Stores media identity and the output decode limit until a first frame is needed. */
  constructor(
    private mediaId: string,
    private maxSide: number,
  ) {}

  /**
   * Lazily loads a URL-backed video, seeks when the requested time changes, and
   * copies that frame into a reusable downscaled canvas. Missing URLs return
   * `null`; the object remains reusable for later requests.
   */
  async frameAt(st: number): Promise<FrameSource | null> {
    if (!this.v) {
      const url = await getObjectUrl(this.mediaId);
      if (!url) return null;
      this.v = await loadVideoElement(url);
    }
    const v = this.v;
    if (Math.abs(st - this.last) > 1e-4 || !this.canvas) {
      await seekElement(v, st);
      const vw = v.videoWidth || 2;
      const vh = v.videoHeight || 2;
      const k = Math.min(1, this.maxSide / Math.max(vw, vh));
      const w = Math.max(2, Math.round(vw * k));
      const h = Math.max(2, Math.round(vh * k));
      if (!this.canvas) this.canvas = makeCanvas(w, h);
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
      this.canvas.getContext('2d')!.drawImage(v, 0, 0, w, h);
      this.last = st;
      this.version = ++exportVersion;
    }
    return { source: this.canvas, version: this.version };
  }

  /** Releases the media element's URL-backed decoder and clears it for GC. */
  dispose() {
    if (this.v) {
      this.v.removeAttribute('src');
      this.v.load();
    }
    this.v = null;
  }
}

/**
 * Frame-provider adapter for a single offline render pass.
 *
 * `prepare` records the scene's requested frames in a dry run, fulfills them,
 * and then exposes synchronous lookups during the real `buildFrame` call.
 * This two-pass pattern lets scene logic stay provider-agnostic.
 */
class OfflineFrames implements FrameProvider {
  private sources = new Map<string, SeqSource>();
  private ready = new Map<string, FrameSource | null>();
  private readyImages = new Map<string, FrameSource | null>();
  private requests = new Map<string, { item: VideoItem; st: number }>();
  private imageRequests = new Map<string, ImageItem>();
  private recording = false;

  /** Captures decode limits and optional cancellation/cutout progress callbacks. */
  constructor(
    private maxSide: number,
    private options: { signal?: AbortSignal; onCutout?: (status: BackgroundStatus) => void } = {},
  ) {}

  /** Records a video dependency while dry-running; otherwise returns the prepared frame. */
  video(item: VideoItem, st: number): FrameSource | null {
    if (this.recording) this.requests.set(item.id, { item, st });
    return this.ready.get(item.id) ?? null;
  }

  /** Records an image dependency while dry-running, then returns a prepared/cached frame. */
  image(item: ImageItem): FrameSource | null {
    if (this.recording) this.imageRequests.set(item.id, item);
    return this.readyImages.get(item.id) ?? (peekImage(item.mediaId) ? { source: peekImage(item.mediaId)!, version: 1 } : null);
  }

  /**
   * Lazily creates an exact-frame decoder for an item id, preferring WebCodecs
   * when asset metadata says it is available and falling back to a video element.
   */
  private async source(item: VideoItem): Promise<SeqSource> {
    let s = this.sources.get(item.id);
    if (s) return s;
    const asset = getAsset(item.mediaId);
    const blob = await getBlob(item.mediaId);
    if (asset?.canDecodeVideo && blob) s = new SinkFrames(blob, this.maxSide);
    else s = new ElementFrames(item.mediaId, this.maxSide);
    this.sources.set(item.id, s);
    return s;
  }

  /**
   * Dry-runs the scene to discover active media, then decodes and optionally
   * segments each required frame before the real scene build.
   *
   * A WebCodecs decoder failure is replaced with `ElementFrames`. Cutout
   * requests carry cancellation/progress through to the worker coordinator.
   * Finished item decoders/caches are disposed/deleted as the timeline moves on.
   */
  async prepare(p: Project, t: number, W: number, H: number, texts: TextCache) {
    this.requests.clear();
    this.imageRequests.clear();
    this.recording = true;
    try {
      buildFrame(p, t, { W, H, asset: getAsset, provider: this, texts, seed: 0 });
    } finally {
      this.recording = false;
    }
    for (const { item, st } of this.requests.values()) {
      let src = await this.source(item);
      let f: FrameSource | null;
      try {
        f = await src.frameAt(st);
      } catch (e) {
        if (!(src instanceof SinkFrames)) throw e;
        console.warn('WebCodecs decode failed during export, using <video> fallback', e);
        src.dispose();
        src = new ElementFrames(item.mediaId, this.maxSide);
        this.sources.set(item.id, src);
        f = await src.frameAt(st);
      }
      if (f && readBackgroundRemoval(item).mode === 'subject') {
        f = {
          ...f,
          matte: await subjectMatte(subjectMatteKey(item.mediaId, st), f.source, {
            signal: this.options.signal,
            onProgress: this.options.onCutout,
          }),
        };
      }
      this.ready.set(item.id, f);
    }
    for (const item of this.imageRequests.values()) {
      const source = peekImage(item.mediaId);
      if (!source) {
        this.readyImages.set(item.id, null);
        continue;
      }
      let frame: FrameSource = { source, version: 1 };
      if (readBackgroundRemoval(item).mode === 'subject') {
        frame = {
          ...frame,
          matte: await subjectMatte(subjectMatteKey(item.mediaId, null), source, {
            signal: this.options.signal,
            onProgress: this.options.onCutout,
          }),
        };
      }
      this.readyImages.set(item.id, frame);
    }
    // Release decoders of clips that are finished.
    for (const [id, s] of this.sources) {
      if (this.requests.has(id)) continue;
      const it = [...p.main, ...p.overlays].find((x) => x.id === id);
      if (!it || it.start + it.duration <= t) {
        s.dispose();
        this.sources.delete(id);
        this.ready.delete(id);
      }
    }
    for (const id of this.readyImages.keys()) {
      const it = [...p.main, ...p.overlays].find((x) => x.id === id);
      if (!it || it.start + it.duration <= t) this.readyImages.delete(id);
    }
  }

  /** Disposes all decoders and drops every prepared frame cache. */
  dispose() {
    for (const s of this.sources.values()) s.dispose();
    this.sources.clear();
    this.ready.clear();
    this.readyImages.clear();
  }
}

/**
 * Loads all audio/video/image/text resources needed by the cloned project in
 * parallel where possible. Font and image failures are intentionally tolerated
 * because the renderer can use a later fallback/empty frame, while core asset
 * loading still propagates.
 */
async function preloadResources(p: Project) {
  const ids = new Set<string>();
  for (const it of [...p.main, ...p.overlays, ...p.audios]) if ('mediaId' in it) ids.add(it.mediaId);
  await loadAssets([...ids]);
  const images = [...p.main, ...p.overlays].filter((i) => i.type === 'image');
  await Promise.all(images.map((i) => (i.type === 'image' ? getImage(i.mediaId).catch(() => null) : null)));
  await Promise.all(p.texts.map((t) => ensureFont(t.style.font, t.style.weight, t.style.italic).catch(() => undefined)));
}

// ---------------------------------------------------------------------------
// Encoders

/**
 * Selects a stereo/48 kHz output codec in browser order: AAC (including the
 * polyfill registered by `canEncodeAac`) followed by Opus. A `null` result means
 * the video is still encodable but is exported without audio.
 */
async function pickAudioCodec(): Promise<AudioCodec | null> {
  const opts = { numberOfChannels: 2, sampleRate: SAMPLE_RATE, bitrate: AUDIO_BITRATE };
  if (await canEncodeAac(opts)) return 'aac';
  if (await canEncodeAudio('opus', opts).catch(() => false)) return 'opus';
  return null;
}

/** Picks the first supported hardware/browser video codec from the preferred compatibility order. */
async function pickVideoCodec(w: number, h: number, fps: number, bitrate: number): Promise<VideoCodec | null> {
  return getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width: w, height: h, frameRate: fps, bitrate });
}

/**
 * Probes whether WebCodecs and a preferred video codec support these exact
 * dimensions, frame rate, and bitrate. It does not allocate an output and
 * converts unsupported probe errors into `false`.
 */
export async function canExport(p: Project, s: ExportSettings): Promise<boolean> {
  if (typeof VideoEncoder === 'undefined') return false;
  const { w, h } = exportDims(p, s);
  return (await pickVideoCodec(w, h, s.fps, videoBitrate(p, s)).catch(() => null)) !== null;
}

/** Creates the stable cancellation exception expected by export callers. */
function abortError() {
  return new DOMException('Export cancelled', 'AbortError');
}

/**
 * Renders a project snapshot to an in-memory MP4 by interleaving audio-ahead
 * mixing with exact-timestamp video frames.
 *
 * The project is deep-cloned so preview/store edits cannot change frame
 * semantics mid-export. Resource preload, codec probing, frame preparation,
 * canvas composition, and one-second audio mixing advance under an abort
 * signal. Audio is scheduled at least one second ahead of video to keep the
 * muxer fed; video timestamps are exactly `i / fps`. Progress reserves the
 * final two percent for finalization, and errors propagate after every
 * temporary decoder/mixer/compositor/output resource is cleaned up.
 *
 * The wake lock is released after completion/failure, though it is optional on
 * unsupported platforms. A null audio codec intentionally creates a silent MP4.
 */
export async function exportVideo(
  project: Project,
  settings: ExportSettings,
  opts: { signal?: AbortSignal; onProgress?: (e: ExportProgress) => void } = {},
): Promise<ExportResult> {
  const { signal, onProgress } = opts;
  const p = JSON.parse(JSON.stringify(project)) as Project;
  const duration = projectDuration(p);
  if (duration <= 0) throw new Error('Add some media to the timeline first');
  if (typeof VideoEncoder === 'undefined') throw new Error('This browser cannot encode video (WebCodecs is unavailable)');
  onProgress?.({ phase: 'prepare', progress: 0, eta: null });

  const { w: W, h: H } = exportDims(p, settings);
  const fps = settings.fps;
  const bitrate = videoBitrate(p, settings);
  const vcodec = await pickVideoCodec(W, H, fps, bitrate);
  if (!vcodec) throw new Error(`This device cannot encode ${W}×${H} video at ${fps} fps. Try a lower resolution or frame rate.`);
  const acodec = await pickAudioCodec();
  await preloadResources(p);
  if (signal?.aborted) throw abortError();

  const wake = await acquireWakeLock();
  const canvas = makeCanvas(W, H);
  const comp = new Compositor(canvas, { preserve: true });
  const texts = new TextCache();
  const frames = new OfflineFrames(Math.max(W, H), {
    signal,
    onCutout: (status) => onProgress?.({ phase: 'cutout', progress: status.progress ?? 0, eta: null }),
  });
  const mixer = acodec ? new AudioMixer(() => p, SAMPLE_RATE, 2) : null;
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const video = new CanvasSource(canvas, {
    codec: vcodec,
    quality: new Quality({ bitrate }),
    keyFrameInterval: 2,
    latencyMode: 'quality',
  });
  output.addVideoTrack(video, { frameRate: fps });
  const audio = acodec ? new AudioBufferSource({ codec: acodec, quality: new Quality({ bitrate: AUDIO_BITRATE }) }) : null;
  if (audio) output.addAudioTrack(audio);

  let audioT = 0;
  // This closure advances the audio cursor in bounded one-second chunks and
  // creates explicit silent buffers where the mixer finds no active source.
  const pushAudio = async (until: number) => {
    if (!audio || !mixer) return;
    while (audioT < until && audioT < duration) {
      const len = Math.max(1, Math.round(Math.min(1, duration - audioT) * SAMPLE_RATE));
      const data = await mixer.mix(audioT, len);
      const buf = new AudioBuffer({ length: len, numberOfChannels: 2, sampleRate: SAMPLE_RATE });
      if (data) {
        buf.copyToChannel(data[0] as Float32Array<ArrayBuffer>, 0);
        buf.copyToChannel(data[1] as Float32Array<ArrayBuffer>, 1);
      }
      await audio.add(buf);
      audioT += len / SAMPLE_RATE;
    }
  };

  let finished = false;
  try {
    await output.start();
    const total = Math.max(1, Math.round(duration * fps));
    const t0 = performance.now();
    for (let i = 0; i < total; i++) {
      if (signal?.aborted) throw abortError();
      const t = Math.min(i / fps, duration - 0.001);
      await pushAudio(t + 1);
      await frames.prepare(p, t, W, H, texts);
      const { spec } = buildFrame(p, t, {
        W,
        H,
        asset: getAsset,
        provider: frames,
        texts,
        seed: Math.floor(t * p.fps),
      });
      comp.render(spec);
      if (comp.lost) throw new Error('The graphics context was lost during export. Please try again.');
      await video.add(i / fps, 1 / fps);
      if (i % 3 === 0 || i === total - 1) {
        const done = (i + 1) / total;
        const el = (performance.now() - t0) / 1000;
        onProgress?.({ phase: 'render', progress: done * 0.98, eta: i > 10 ? (el / done) * (1 - done) : null });
      }
    }
    await pushAudio(duration);
    onProgress?.({ phase: 'finalize', progress: 0.99, eta: 0 });
    video.close();
    audio?.close();
    await output.finalize();
    finished = true;
    const buffer = output.target.buffer;
    if (!buffer) throw new Error('Export produced no data');
    onProgress?.({ phase: 'finalize', progress: 1, eta: 0 });
    const safe = safeFileName(p.name, 'ReelForge');
    return {
      blob: new Blob([buffer], { type: 'video/mp4' }),
      width: W,
      height: H,
      duration,
      codec: `${vcodec}${acodec ? ' + ' + acodec : ''}`,
      fileName: `${safe}.mp4`,
    };
  } finally {
    if (!finished) await output.cancel().catch(() => undefined);
    frames.dispose();
    mixer?.dispose();
    texts.clear();
    comp.dispose();
    canvas.width = canvas.height = 1;
    void wake?.release().catch(() => undefined);
  }
}

/**
 * Renders one composited project frame to an encoded image blob.
 *
 * Time is clamped to the project endpoint. Per-call decoders, text cache, and GL
 * state are private, while shared media/model caches remain available. The
 * requested MIME type and quality are passed to `canvas.toBlob`; a null browser
 * result becomes an error. No audio, progress, cancellation, or wake lock is
 * involved.
 */
export async function renderStill(project: Project, t: number, shortSide = 1080, type = 'image/png'): Promise<Blob> {
  const p = JSON.parse(JSON.stringify(project)) as Project;
  const { w: W, h: H } = canvasSize(p.aspect, shortSide);
  await preloadResources(p);
  const canvas = makeCanvas(W, H);
  const comp = new Compositor(canvas, { preserve: true });
  const texts = new TextCache();
  const frames = new OfflineFrames(Math.max(W, H));
  try {
    const dur = projectDuration(p);
    const tt = clamp(t, 0, Math.max(0, dur - 0.001));
    await frames.prepare(p, tt, W, H, texts);
    const { spec } = buildFrame(p, tt, { W, H, asset: getAsset, provider: frames, texts, seed: Math.floor(tt * p.fps) });
    comp.render(spec);
    return await new Promise<Blob>((res, rej) =>
      canvas.toBlob((b) => (b ? res(b) : rej(new Error('Could not encode image'))), type, 0.95),
    );
  } finally {
    frames.dispose();
    texts.clear();
    comp.dispose();
  }
}
