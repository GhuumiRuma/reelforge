/**
 * Interactive editor preview scheduler. A bounded pool of hidden video
 * elements (with WebCodecs fallback) supplies reusable frame canvases to the
 * WebGL scene builder, while `AudioPlayback` owns the clock and this engine owns
 * rAF, seeking, preroll, cutout requests, hit quads, and slot cleanup.
 */
import { ALL_FORMATS, BlobSource, CanvasSink, Input } from 'mediabunny';
import type { Project, VideoItem } from '../types';
import { readBackgroundRemoval } from '../lib/background';
import { canvasSize, projectDuration } from '../lib/layout';
import { getAsset, getBlob, mediaEvents, peekImage, peekObjectUrl } from '../lib/media';
import { fontEvents } from '../lib/text';
import { clamp, isIOS } from '../lib/util';
import { AudioPlayback } from './audio';
import { peekRecentSubjectMatte, subjectMatte, subjectMatteBusy, subjectMatteKey } from './background';
import { Compositor } from './gl';
import { buildFrame, TextCache, type FrameProvider, type HitQuad } from './scene';

const MAX_SLOTS = 6;
const PREROLL = 1.5;
const MAX_PIXELS = 1.6e6;
let frameVersion = 0;

/**
 * On-demand WebCodecs replacement for a video element that cannot play a file.
 *
 * Requests collapse while a canvas fetch is busy and only the newest wanted
 * timestamp is retried. The fallback scales to the active preview's maximum side
 * and owns its Mediabunny input until the containing slot is destroyed.
 */
class SinkFallback {
  private input: Input | null = null;
  private sink: CanvasSink | null = null;
  private busy = false;
  private want: number | null = null;
  private last = -1;
  private disposed = false;
  readonly ready: Promise<boolean>;

  /** Starts asynchronous track/sink initialization and stores the frame delivery callback. */
  constructor(
    mediaId: string,
    maxSide: number,
    private onFrame: (c: HTMLCanvasElement | OffscreenCanvas) => void,
  ) {
    this.ready = this.init(mediaId, maxSide);
  }

  /**
   * Lazily loads the blob, verifies a decodable primary track, and constructs a
   * small pooled `CanvasSink`. Any unsupported/decode setup failure resolves as
   * `false`, letting the slot remain frame-less rather than throwing off-rAF.
   */
  private async init(id: string, maxSide: number): Promise<boolean> {
    try {
      const blob = await getBlob(id);
      if (!blob || this.disposed) return false;
      this.input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
      const track = await this.input.getPrimaryVideoTrack();
      if (!track || !(await track.canDecode())) return false;
      const w = await track.getDisplayWidth();
      const h = await track.getDisplayHeight();
      const s = Math.min(1, maxSide / Math.max(w, h, 1));
      this.sink = new CanvasSink(track, {
        width: Math.max(2, Math.round(w * s)),
        height: Math.max(2, Math.round(h * s)),
        fit: 'fill',
        poolSize: 2,
      });
      return !this.disposed;
    } catch (e) {
      console.warn('WebCodecs preview fallback failed', e);
      return false;
    }
  }

  /**
   * Coalesces a frame request with the currently running fetch, retaining only
   * the latest timestamp. Identical repeated timestamps are ignored.
   */
  request(t: number) {
    if (Math.abs(t - this.last) < 1e-3) return;
    if (this.busy) {
      this.want = t;
      return;
    }
    void this.fetch(t);
  }

  /** Fetches the requested canvas (or one from 50 ms earlier) and retries the pending newest request. */
  private async fetch(t: number) {
    this.busy = true;
    try {
      if (!(await this.ready) || !this.sink || this.disposed) return;
      const wc = (await this.sink.getCanvas(t)) ?? (await this.sink.getCanvas(Math.max(0, t - 0.05)));
      this.last = t;
      if (wc && !this.disposed) this.onFrame(wc.canvas);
    } catch (e) {
      console.warn('fallback frame failed', e);
    } finally {
      this.busy = false;
      const w = this.want;
      this.want = null;
      if (w !== null && !this.disposed) this.request(w);
    }
  }

  /** Marks the object closed and releases its demuxer/sink references. */
  dispose() {
    this.disposed = true;
    this.input?.dispose();
    this.input = null;
    this.sink = null;
  }
}

/** Mutable decoder/video state retained in the preview slot pool. */
interface Slot {
  id: string;
  mediaId: string;
  v: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  version: number;
  hasFrame: boolean;
  drawnAt: number;
  dirty: boolean;
  meta: boolean;
  seeking: boolean;
  pending: number | null;
  target: number;
  lastUsed: number;
  playing: boolean;
  noPlay: boolean;
  lastFix: number;
  sink: SinkFallback | null;
  off: () => void;
}

/** Construction callbacks and canvas used by one interactive preview owner. */
export interface PreviewOptions {
  canvas: HTMLCanvasElement;
  getProject: () => Project;
  /** Called on every frame while playing (and when playback stops). */
  onTime?: (t: number) => void;
  onPlayState?: (playing: boolean) => void;
  /** Called after each rendered frame (e.g. to redraw selection handles). */
  onRender?: () => void;
  onBackgroundError?: (message: string) => void;
}

/**
 * Live preview: renders the project with the WebGL compositor, decoding video through
 * pooled <video> elements, with the audio engine as the master clock.
 */
export class PreviewEngine {
  /** Master-clock scheduler used by the preview; public for one-shot audio access. */
  readonly audio: AudioPlayback;
  /** GPU compositor owned by this engine and exposed for controlled pixel consumers. */
  readonly comp: Compositor;
  private texts = new TextCache();
  private slots = new Map<string, Slot>();
  private wants = new Map<string, { item: VideoItem; st: number }>();
  private box: HTMLDivElement;
  private raf = 0;
  private frameNo = 0;
  private short = 720;
  private t = 0;
  private isPlaying = false;
  private peekT: number | null = null;
  private disposed = false;
  private provider: FrameProvider;
  private failedMattes = new Set<string>();
  /** Hit-test quads of the last rendered frame (frame pixel space, topmost last). */
  quads: HitQuad[] = [];
  /** Last composited width/height, used by callers that map frame geometry to the editor canvas. */
  frameW = 2;
  frameH = 2;
  /** Timeline time of the last rendered frame. */
  renderedAt = 0;

  /** Creates compositor/audio/text resources, installs external invalidators, and schedules the first frame. */
  constructor(private opts: PreviewOptions) {
    this.comp = new Compositor(opts.canvas);
    this.comp.onRestored = () => this.requestRender();
    this.audio = new AudioPlayback(opts.getProject);
    this.box = document.createElement('div');
    this.box.setAttribute('aria-hidden', 'true');
    this.box.style.cssText =
      'position:fixed;left:0;top:0;width:2px;height:2px;overflow:hidden;opacity:0.01;pointer-events:none;z-index:-1;';
    document.body.appendChild(this.box);
    this.provider = {
      video: (item, st) => this.videoFrame(item, st),
      image: (item) => this.imageFrame(item),
    };
    mediaEvents.addEventListener('update', this.onExternal);
    fontEvents.addEventListener('loaded', this.onExternal);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.requestRender();
  }

  // -------------------------------------------------------------------------
  // Public API

  /** Whether the engine currently follows the audio master clock. */
  get playing() {
    return this.isPlaying;
  }

  /** Current preview time: audio time while playing, paused/sought time otherwise. */
  get time() {
    return this.isPlaying ? this.audio.now() : this.t;
  }

  /**
   * Updates the requested short-side render resolution from CSS size and DPR.
   * Work is rounded/clamped to a 180-1080 px short side and only a changed value
   * schedules rendering.
   */
  setViewport(cssW: number, cssH: number, dpr = window.devicePixelRatio || 1) {
    const s = clamp(Math.round(Math.min(cssW, cssH) * Math.min(dpr, 3)), 180, 1080);
    if (s !== this.short) {
      this.short = s;
      this.requestRender();
    }
  }

  /**
   * Invalidates failed cutout suppression and live audio remix after an edit,
   * then schedules a fresh frame. It never replaces currently warm video slots.
   */
  projectChanged() {
    this.failedMattes.clear();
    if (this.isPlaying) this.audio.invalidate();
    this.requestRender();
  }

  /**
   * Moves the playhead. During playback it restarts the audio clock from the
   * new time and forces video drift correction; while paused it stores the time
   * and requests a frame. Sub-100 ms live jumps are ignored to avoid jitter.
   */
  seek(t: number) {
    t = Math.max(0, t);
    if (this.isPlaying) {
      if (Math.abs(t - this.audio.now()) < 0.1) return;
      this.audio.start(t);
      for (const s of this.slots.values()) s.lastFix = 0;
      this.kick();
      return;
    }
    if (t === this.t) return;
    this.t = t;
    this.requestRender();
  }

  /**
   * Temporarily renders a different time while paused (for trim/scrub previews)
   * without changing `t`; passing `null` resumes the actual playhead.
   */
  setPeek(t: number | null) {
    if (t === this.peekT) return;
    this.peekT = t;
    this.requestRender();
  }

  /**
   * Starts the audio clock from a user gesture and synchronously renders once so
   * active `<video>.play()` calls also happen inside that gesture. It loops from
   * the beginning when the paused playhead is at the end and notifies observers
   * after playback has been scheduled.
   */
  play() {
    if (this.isPlaying || this.disposed) return;
    const dur = projectDuration(this.opts.getProject());
    if (dur <= 0.01) return;
    let t = this.t;
    if (t >= dur - 0.05) t = 0;
    this.t = t;
    this.peekT = null;
    this.isPlaying = true;
    this.audio.start(t);
    for (const s of this.slots.values()) s.lastFix = 0;
    // Render synchronously so active videos call play() inside the gesture.
    this.renderNow();
    if (isIOS) {
      for (const s of this.slots.values()) {
        if (s.playing || s.noPlay || !s.meta) continue;
        const v = s.v;
        void v
          .play()
          .then(() => {
            if (!s.playing) v.pause();
          })
          .catch(() => undefined);
      }
    }
    this.opts.onPlayState?.(true);
    this.kick();
  }

  /**
   * Captures the audio time, stops audio/video playback, reports paused time/state,
   * and requests a stable still frame. Calling it while paused is a no-op.
   */
  pause() {
    if (!this.isPlaying) return;
    const dur = projectDuration(this.opts.getProject());
    this.t = clamp(this.audio.now(), 0, dur);
    this.audio.stop();
    this.isPlaying = false;
    for (const s of this.slots.values()) this.stopSlot(s);
    this.opts.onTime?.(this.t);
    this.opts.onPlayState?.(false);
    this.requestRender();
  }

  /** Toggles playback while preserving the normal play/pause side effects. */
  toggle() {
    if (this.isPlaying) this.pause();
    else this.play();
  }

  /** Coalesces frame requests into one pending animation-frame callback. */
  requestRender() {
    if (this.disposed || this.raf) return;
    this.raf = requestAnimationFrame(this.loop);
  }

  /**
   * Builds and composites the currently effective time immediately, before the
   * next animation frame.
   *
   * Ready slot canvases are copied, the synchronous scene provider records its
   * wants/hit quads, WebGL renders, and slot seek/playback state is synchronized.
   * This is safe for pixel-read callers but still depends on previously decoded
   * media; it does not await a not-ready frame.
   */
  renderNow() {
    if (this.disposed) return;
    const p = this.opts.getProject();
    const dur = projectDuration(p);
    let t = this.peekT !== null && !this.isPlaying ? this.peekT : this.isPlaying ? this.audio.now() : this.t;
    t = clamp(t, 0, Math.max(0, dur - 0.001));
    for (const s of this.slots.values()) this.maybeDraw(s);
    const { w, h } = this.frameSize(p);
    this.wants.clear();
    const { spec, quads } = buildFrame(p, t, {
      W: w,
      H: h,
      asset: getAsset,
      provider: this.provider,
      texts: this.texts,
      seed: Math.floor(t * p.fps),
    });
    this.comp.render(spec);
    this.quads = quads;
    this.frameW = w;
    this.frameH = h;
    this.renderedAt = t;
    this.frameNo++;
    this.syncSlots(p, t);
    this.opts.onRender?.();
  }

  /**
   * Stops playback, unregisters media/font/document observers, destroys slots,
   * removes the hidden video container, and releases audio/text/GL resources.
   * Repeated calls are ignored.
   */
  dispose() {
    if (this.disposed) return;
    this.pause();
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    mediaEvents.removeEventListener('update', this.onExternal);
    fontEvents.removeEventListener('loaded', this.onExternal);
    document.removeEventListener('visibilitychange', this.onVisibility);
    for (const s of [...this.slots.values()]) this.destroySlot(s);
    this.box.remove();
    this.audio.dispose();
    this.texts.clear();
    this.comp.dispose();
  }

  // -------------------------------------------------------------------------
  // Loop

  /** Coalesces media-store and font readiness events into one redraw. */
  private onExternal = () => this.requestRender();

  /** Pauses playback when the tab is hidden so audio/video do not keep burning resources. */
  private onVisibility = () => {
    if (document.visibilityState === 'hidden') this.pause();
  };

  /** Starts a fresh rAF cycle when `play()` cannot rely on an already scheduled frame. */
  private kick() {
    if (!this.raf && !this.disposed) this.raf = requestAnimationFrame(this.loop);
  }

  /**
   * Animation-frame owner for playback and one-shot redraws.
   *
   * During playback it reports audio-clock time, schedules the next tick before
   * rendering, and finalizes/pauses at project duration. Outside playback a
   * requested frame runs exactly once.
   */
  private loop = () => {
    this.raf = 0;
    if (this.disposed) return;
    if (this.isPlaying) {
      const dur = projectDuration(this.opts.getProject());
      const now = this.audio.now();
      if (now >= dur) {
        this.t = dur;
        this.audio.stop();
        this.isPlaying = false;
        for (const s of this.slots.values()) this.stopSlot(s);
        this.opts.onTime?.(dur);
        this.opts.onPlayState?.(false);
        this.renderNow();
        return;
      }
      this.opts.onTime?.(now);
      this.raf = requestAnimationFrame(this.loop);
    }
    this.renderNow();
  };

  /**
   * Converts project aspect/short side to output dimensions, then scales down
   * extreme aspect ratios to stay below the preview's pixel budget.
   */
  private frameSize(p: Project) {
    let { w, h } = canvasSize(p.aspect, this.short);
    if (w * h > MAX_PIXELS) {
      const s = Math.sqrt(MAX_PIXELS / (w * h));
      ({ w, h } = canvasSize(p.aspect, Math.round(this.short * s)));
    }
    return { w, h };
  }

  // -------------------------------------------------------------------------
  // Video slots

  /**
   * Records a requested source time and returns a ready canvas.
   *
   * If this item's slot is warming, it may borrow the closest already-decoded
   * canvas for the same media to avoid a blank across splits/duplicates. The
   * optional subject matte is attached by `withMatte`.
   */
  private videoFrame(item: VideoItem, st: number) {
    this.wants.set(item.id, { item, st });
    let s = this.slots.get(item.id);
    if (!s || s.mediaId !== item.mediaId || !s.hasFrame) {
      // Show any other decoded frame of the same media while this slot warms up (e.g. right after a split).
      s = undefined;
      for (const o of this.slots.values()) {
        if (o.mediaId === item.mediaId && o.hasFrame && (!s || Math.abs(o.drawnAt - st) < Math.abs(s.drawnAt - st))) s = o;
      }
      if (!s) return null;
    }
    return this.withMatte(item, { source: s.canvas, version: s.version }, s.drawnAt);
  }

  /** Returns the media-store image cache when ready and attaches any requested subject matte. */
  private imageFrame(item: Parameters<FrameProvider['image']>[0]) {
    const source = peekImage(item.mediaId);
    return source ? this.withMatte(item, { source, version: 1 }, null) : null;
  }

  /**
   * Augments a ready frame with an exact/recent subject matte.
   *
   * A miss launches inference only when no matte request is globally busy and
   * that key has not failed; this throttles the preview to one worker request at
   * a time. The bare frame is returned immediately so video continues, and a
   * successful request schedules replacement rendering.
   */
  private withMatte<T extends { mediaId: string } & Project['main'][number]>(
    item: T,
    frame: { source: TexImageSource; version: number | string },
    sourceTime: number | null,
  ): ReturnType<FrameProvider['video']> {
    if (readBackgroundRemoval(item).mode !== 'subject') return frame;
    const key = subjectMatteKey(item.mediaId, sourceTime);
    const ready = peekRecentSubjectMatte(item.mediaId, sourceTime);
    if (ready) return { ...frame, matte: ready };
    if (!subjectMatteBusy() && !this.failedMattes.has(key)) {
      this.failedMattes.add(key);
      void subjectMatte(key, frame.source)
        .then(() => {
          this.failedMattes.delete(key);
          this.requestRender();
        })
        .catch((error) => {
          if (!this.failedMattes.has(key)) return;
          console.warn('Background cutout failed', error);
          this.opts.onBackgroundError?.(error instanceof Error ? error.message : 'Could not remove this background.');
        });
    }
    return frame;
  }

  /** Maximum intrinsic decode side, including a 640 px floor for crisp small viewports. */
  private maxSide() {
    return Math.max(this.frameW, this.frameH, 640);
  }

  /**
   * Copies the latest `<video>` frame into the slot canvas before scene build.
   * WebCodecs slots are already fed by `SinkFallback`; native slots skip copy
   * while seeking/not ready or unchanged since the last draw.
   */
  private maybeDraw(s: Slot) {
    if (s.sink) return;
    const v = s.v;
    if (s.seeking || v.readyState < 2) return;
    if (this.isPlaying ? !s.dirty && v.currentTime === s.drawnAt : !s.dirty) return;
    this.drawFrom(s, v, v.videoWidth, v.videoHeight);
    s.drawnAt = v.currentTime;
  }

  /**
   * Downscales any ready canvas/video source into the reusable slot canvas.
   * Canvas resize and draw failures preserve the previous texture frame; a
   * successful copy increments the texture version for WebGL upload.
   */
  private drawFrom(s: Slot, src: CanvasImageSource, sw: number, sh: number) {
    if (!sw || !sh) return;
    const k = Math.min(1, this.maxSide() / Math.max(sw, sh));
    const cw = Math.max(2, Math.round(sw * k));
    const ch = Math.max(2, Math.round(sh * k));
    if (s.canvas.width !== cw || s.canvas.height !== ch) {
      s.canvas.width = cw;
      s.canvas.height = ch;
    }
    if (!s.ctx) return;
    try {
      s.ctx.drawImage(src, 0, 0, cw, ch);
    } catch {
      return;
    }
    s.version = ++frameVersion;
    s.hasFrame = true;
    s.dirty = false;
  }

  /**
   * Constructs a hidden native video element and frame canvas for one item.
   *
   * Its internal event closures translate metadata/data/seek completion into
   * slot state; a media error from the native element switches to
   * `SinkFallback` only when metadata says WebCodecs may decode the file. All
   * listeners are packaged into `off` so adoption/destruction cannot leak
   * element handlers.
   */
  private createSlot(id: string, mediaId: string, url: string): Slot {
    const v = document.createElement('video');
    v.muted = true;
    v.defaultMuted = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.setAttribute('muted', '');
    v.preload = 'auto';
    v.disableRemotePlayback = true;
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    const s: Slot = {
      id,
      mediaId,
      v,
      canvas,
      ctx: canvas.getContext('2d', { alpha: false }),
      version: 0,
      hasFrame: false,
      drawnAt: -1,
      dirty: false,
      meta: false,
      seeking: false,
      pending: null,
      target: -1,
      lastUsed: this.frameNo,
      playing: false,
      noPlay: false,
      lastFix: 0,
      sink: null,
      off: () => undefined,
    };
    const onMeta = () => {
      s.meta = true;
      const t = s.pending ?? s.target;
      s.pending = null;
      if (t >= 0 && !s.playing) this.seekSlot(s, t, true);
      else if (isIOS && v.readyState < 2 && !s.playing) {
        // iOS may not fetch frame data until playback is attempted.
        void v
          .play()
          .then(() => {
            if (!s.playing) v.pause();
          })
          .catch(() => undefined);
      }
    };
    const onData = () => {
      s.dirty = true;
      this.requestRender();
    };
    const onSeeked = () => {
      s.seeking = false;
      s.dirty = true;
      const p = s.pending;
      s.pending = null;
      if (p !== null && Math.abs(p - v.currentTime) > 0.002) this.seekSlot(s, p, true);
      this.requestRender();
    };
    const onError = () => {
      if (s.sink) return;
      const asset = getAsset(mediaId);
      console.warn('Video element cannot play this file; trying WebCodecs', asset?.name, v.error);
      if (asset && !asset.canDecodeVideo) return;
      s.sink = new SinkFallback(mediaId, this.maxSide(), (c) => {
        this.drawFrom(s, c, c.width, c.height);
        this.requestRender();
      });
      if (s.target >= 0) s.sink.request(s.target);
    };
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('loadeddata', onData);
    v.addEventListener('seeked', onSeeked);
    v.addEventListener('error', onError);
    s.off = () => {
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('loadeddata', onData);
      v.removeEventListener('seeked', onSeeked);
      v.removeEventListener('error', onError);
    };
    this.box.appendChild(v);
    v.src = url;
    v.load();
    this.slots.set(id, s);
    return s;
  }

  /**
   * Stops and unloads a slot's video, disposes fallback decoding, removes its
   * listeners/DOM node, clears canvas pixels, and deletes the matching GL
   * texture. A slot id may be reused only after the old key is released.
   */
  private destroySlot(s: Slot) {
    s.off();
    s.sink?.dispose();
    try {
      s.v.pause();
      s.v.removeAttribute('src');
      s.v.load();
    } catch {
      /* ignore */
    }
    s.v.remove();
    s.canvas.width = s.canvas.height = 1;
    this.slots.delete(s.id);
    this.comp.releaseTexture('vid:' + s.id);
  }

  /**
   * Returns a slot for an item, replacing one whose media id changed.
   *
   * Before creating a decoder, it adopts an idle slot showing the same media
   * (favoring a removed item or most recently used slot). This preserves a warm
   * decoder across split-point identities and releases the old GL cache key.
   */
  private ensureSlot(item: VideoItem, inProject: () => Set<string>): Slot | null {
    let s = this.slots.get(item.id);
    if (s && s.mediaId !== item.mediaId) {
      this.destroySlot(s);
      s = undefined;
    }
    if (s) return s;
    // Adopt an idle slot showing the same media (split parts, duplicates, deleted items): its decoder
    // is warm and, across a split point, already positioned at the right frame.
    let best: Slot | undefined;
    for (const o of this.slots.values()) {
      if (o.mediaId !== item.mediaId || this.wants.has(o.id)) continue;
      if (!best) best = o;
      else {
        const oGone = !inProject().has(o.id);
        const bGone = !inProject().has(best.id);
        if ((oGone && !bGone) || (oGone === bGone && o.lastUsed > best.lastUsed)) best = o;
      }
    }
    if (best) {
      this.slots.delete(best.id);
      this.comp.releaseTexture('vid:' + best.id);
      best.id = item.id;
      best.lastFix = 0;
      this.slots.set(item.id, best);
      return best;
    }
    const url = peekObjectUrl(item.mediaId);
    if (!url) return null;
    return this.createSlot(item.id, item.mediaId, url);
  }

  /**
   * Requests a source timestamp from the native/fallback decoder.
   *
   * Native seeks are coalesced while metadata is loading or an earlier seek is in
   * flight; unchanged close requests can be skipped unless `force` is true.
   */
  private seekSlot(s: Slot, t: number, force = false) {
    s.target = t;
    if (s.sink) {
      s.sink.request(t);
      return;
    }
    if (!s.meta) {
      s.pending = t;
      return;
    }
    if (s.seeking) {
      s.pending = t;
      return;
    }
    if (!force && s.hasFrame && Math.abs(s.v.currentTime - t) < 0.004) return;
    s.seeking = true;
    s.pending = null;
    try {
      s.v.currentTime = t;
    } catch {
      s.seeking = false;
    }
  }

  /** Pauses native playback when the slot leaves the active playing scene. */
  private stopSlot(s: Slot) {
    if (!s.playing) return;
    s.playing = false;
    s.v.pause();
  }

  /**
   * Synchronizes all frames requested by the latest scene build with decoder
   * slots. During live playback slots run/drift-correct; during pause/peek they
   * stop and seek. Unwanted slots stop, upcoming clips preroll, then LRU cleanup
   * is attempted.
   */
  private syncSlots(p: Project, t: number) {
    const live = this.isPlaying && this.peekT === null;
    const now = performance.now();
    let inProject: Set<string> | null = null;
    const ids = () => (inProject ??= new Set([...p.main, ...p.overlays].map((i) => i.id)));
    for (const { item, st } of this.wants.values()) {
      const s = this.ensureSlot(item, ids);
      if (!s) continue;
      s.lastUsed = this.frameNo;
      if (live) this.syncPlaying(s, item, st, now);
      else {
        this.stopSlot(s);
        if (Math.abs(s.target - st) > 0.002 || !s.hasFrame) this.seekSlot(s, st);
      }
    }
    for (const s of this.slots.values()) if (!this.wants.has(s.id)) this.stopSlot(s);
    if (live) this.preroll(p, t, ids);
    this.evict();
  }

  /**
   * Advances one slot during live playback.
   *
   * Extreme speed, endpoint, not-ready, fallback, and denied-play cases step by
   * seeking; ordinary native slots play at item speed and receive a periodic
   * hard seek or small playback-rate adjustment to follow the audio clock.
   */
  private syncPlaying(s: Slot, item: VideoItem, st: number, now: number) {
    const v = s.v;
    s.target = st;
    const rate = item.speed;
    const nearEnd = Number.isFinite(v.duration) && st >= v.duration - 0.08;
    if (s.sink || s.noPlay || rate < 0.0625 || rate > 4 || nearEnd || !s.meta) {
      // Step through frames by seeking.
      this.stopSlot(s);
      if (Math.abs(v.currentTime - st) > 0.03 || !s.hasFrame) this.seekSlot(s, st);
      return;
    }
    if (!s.playing || v.paused) {
      if (v.ended || Math.abs(v.currentTime - st) > 0.05) this.seekSlot(s, st, true);
      if (v.playbackRate !== rate) v.playbackRate = rate;
      s.playing = true;
      s.lastFix = now;
      const pr = v.play();
      pr?.catch((e: DOMException) => {
        s.playing = false;
        if (e?.name === 'NotAllowedError') s.noPlay = true;
      });
      return;
    }
    if (s.seeking) return;
    const diff = v.currentTime - st;
    if (Math.abs(diff) > 0.3 && now - s.lastFix > 700) {
      s.lastFix = now;
      s.seeking = true;
      v.currentTime = st + 0.06 * rate;
      if (v.playbackRate !== rate) v.playbackRate = rate;
      return;
    }
    let r = rate;
    if (diff > 0.05) r = rate * 0.94;
    else if (diff < -0.05) r = rate * 1.06;
    else if (Math.abs(diff) > 0.015) r = v.playbackRate;
    if (Math.abs(v.playbackRate - r) > 1e-3) v.playbackRate = r;
  }

  /**
   * Warms slots up to 1.5 s before their start, avoiding duplicate decoders when
   * active/upcoming clips share one media asset. Prewarmed slots seek to the
   * source in point but do not play until `wants` makes them active.
   */
  private preroll(p: Project, t: number, inProject: () => Set<string>) {
    const busyMedia = new Set([...this.wants.values()].map((w) => w.item.mediaId));
    for (const it of [...p.main, ...p.overlays]) {
      // Clips sharing media with a playing clip (e.g. split parts) adopt its slot when they start.
      if (it.type !== 'video' || it.start <= t || it.start > t + PREROLL || busyMedia.has(it.mediaId)) continue;
      const s = this.ensureSlot(it, inProject);
      if (!s) continue;
      s.lastUsed = this.frameNo;
      this.wants.set(it.id, { item: it, st: it.in });
      busyMedia.add(it.mediaId);
      if (!s.playing && Math.abs(s.target - it.in) > 0.002) this.seekSlot(s, it.in);
    }
  }

  /**
   * Enforces the nominal six-slot pool by destroying least-recent idle slots.
   * Active/wanted slots may temporarily exceed the limit rather than breaking
   * the current frame.
   */
  private evict() {
    if (this.slots.size <= MAX_SLOTS) return;
    const idle = [...this.slots.values()]
      .filter((s) => s.lastUsed < this.frameNo && !this.wants.has(s.id))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    while (this.slots.size > MAX_SLOTS && idle.length) this.destroySlot(idle.shift()!);
  }
}
