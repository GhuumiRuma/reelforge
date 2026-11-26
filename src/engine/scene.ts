/**
 * Scene-graph builder for a project frame. It samples item state, acquires
 * image/text frames through caller-owned providers/caches, resolves
 * crop/transform/animation/background semantics, and produces compositor
 * commands plus editor hit quads without issuing WebGL work or reading a clock.
 */
import type { AnimType, ImageItem, MainItem, MediaAsset, OverlayItem, Project, TextItem, VideoItem, VisualItem } from '../types';
import { readBackgroundRemoval } from '../lib/background';
import { activeMain, itemEnd, sampleKeyframes, sourceTime } from '../lib/layout';
import { computeFx } from '../lib/filters';
import { isFontReady, renderTextCanvas, textCharCount } from '../lib/text';
import { backOut, clamp, easeInOut, easeOut, hexToRgb, lerp } from '../lib/util';
import type { DrawLayer, FrameSpec, Page, TexRef } from './gl';

const EPS = 1e-6;
const DEG = Math.PI / 180;

/** A ready browser image source plus a version token; optional matte shares the compositing UV space. */
export interface FrameSource {
  source: TexImageSource;
  version: number | string;
  matte?: { source: TexImageSource; version: number | string } | null;
}

/** Synchronous frame lookup contract; decoders report `null` until asynchronous preparation is ready. */
export interface FrameProvider {
  /** Decoded frame of a video item at the given source time (seconds), or null if not ready. */
  video(item: VideoItem, sourceTime: number): FrameSource | null;
  /** Cached image asset/frame for an image item, or null while the asset is loading. */
  image(item: ImageItem): FrameSource | null;
}

/** Frame dimensions and resource accessors required to resolve a project into draw commands. */
export interface SceneContext {
  W: number;
  H: number;
  /** Returns current media metadata, or undefined while an item has not been registered. */
  asset(id: string): MediaAsset | undefined;
  provider: FrameProvider;
  texts: TextCache;
  seed: number;
}

/** Rotatable layer bounds used by editor picking in frame-pixel coordinates. */
export interface HitQuad {
  id: string;
  kind: 'main' | 'overlays' | 'texts';
  /** frame pixels */
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** radians, clockwise */
  rot: number;
}

/** Resolved item transform/opacity and optional text typewriter state at one timeline instant. */
export interface Pose {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
  /** typewriter: number of visible characters */
  chars: number | null;
}

/**
 * Mutates a resolved pose with one entrance/exit animation at normalized
 * progress `u`. Exit calls use the remaining fraction, so animation formulas
 * can be mirrored without separate phase-specific code. Non-text typewriter
 * falls back to an opacity animation.
 */
function applyAnim(p: Pose, item: VisualItem, type: AnimType, u: number, entering: boolean) {
  const e = easeOut(u);
  const dir = entering ? 1 : -1;
  switch (type) {
    case 'fade':
      p.opacity *= u;
      break;
    case 'zoomIn':
      p.scale *= entering ? lerp(0.5, 1, e) : lerp(1.5, 1, e);
      p.opacity *= e;
      break;
    case 'zoomOut':
      p.scale *= entering ? lerp(1.5, 1, e) : lerp(0.5, 1, e);
      p.opacity *= e;
      break;
    case 'slideUp':
      p.y += (1 - e) * 0.3 * dir;
      p.opacity *= clamp(u * 2, 0, 1);
      break;
    case 'slideDown':
      p.y -= (1 - e) * 0.3 * dir;
      p.opacity *= clamp(u * 2, 0, 1);
      break;
    case 'slideLeft':
      p.x += (1 - e) * 0.4 * dir;
      p.opacity *= clamp(u * 2, 0, 1);
      break;
    case 'slideRight':
      p.x -= (1 - e) * 0.4 * dir;
      p.opacity *= clamp(u * 2, 0, 1);
      break;
    case 'pop':
      p.scale *= Math.max(0, backOut(u));
      p.opacity *= clamp(u * 3, 0, 1);
      break;
    case 'spin':
      p.rotation += (1 - e) * 360 * (entering ? -1 : 1);
      p.scale *= lerp(0.2, 1, e);
      p.opacity *= e;
      break;
    case 'typewriter':
      if (item.type === 'text') {
        const n = Math.floor(u * textCharCount(item.text));
        p.chars = p.chars === null ? n : Math.min(p.chars, n);
      } else {
        p.opacity *= u;
      }
      break;
    default:
      break;
  }
}

/**
 * Resolves the item's keyframed base transform plus continuous pan/zoom motion.
 *
 * Timeline `t` is converted to item-local time; this returns a new pose and
 * deliberately excludes entrance/exit animations so editor selection geometry
 * remains stable and grabbable while those effects move the visible layer.
 */
export function restPose(item: VisualItem, t: number): Pose {
  const local = t - item.start;
  const kv = sampleKeyframes(item.keyframes, local);
  const tr = item.transform;
  const pose: Pose = kv
    ? { ...kv, chars: null }
    : { x: tr.x, y: tr.y, scale: tr.scale, rotation: tr.rotation, opacity: item.opacity, chars: null };
  if (item.motion !== 'none') {
    const u = clamp(local / Math.max(item.duration, EPS), 0, 1);
    switch (item.motion) {
      case 'zoomIn':
        pose.scale *= lerp(1, 1.2, u);
        break;
      case 'zoomOut':
        pose.scale *= lerp(1.2, 1, u);
        break;
      case 'panLeft':
        pose.scale *= 1.2;
        pose.x += lerp(0.08, -0.08, u);
        break;
      case 'panRight':
        pose.scale *= 1.2;
        pose.x += lerp(-0.08, 0.08, u);
        break;
      case 'panUp':
        pose.scale *= 1.2;
        pose.y += lerp(0.08, -0.08, u);
        break;
      case 'panDown':
        pose.scale *= 1.2;
        pose.y += lerp(-0.08, 0.08, u);
        break;
    }
  }
  return pose;
}

/**
 * Reports whether a visual item is inside either configured in/out interval.
 * Durations are capped at the item's lifetime, including for very short clips.
 */
const animating = (item: VisualItem, local: number) =>
  (item.animIn.type !== 'none' && local < Math.min(item.animIn.duration, item.duration)) ||
  (item.animOut.type !== 'none' && local > item.duration - Math.min(item.animOut.duration, item.duration));

/**
 * Resolves the rendered transform at timeline time `t`, starting from
 * `restPose` and applying each capped entrance/exit effect in order (effects
 * may overlap on very short items). The returned object is independent of the
 * source item.
 */
export function itemPose(item: VisualItem, t: number): Pose {
  const local = t - item.start;
  const pose = restPose(item, t);
  const dIn = Math.min(item.animIn.duration, item.duration);
  const dOut = Math.min(item.animOut.duration, item.duration);
  if (item.animIn.type !== 'none' && dIn > 0 && local < dIn) {
    applyAnim(pose, item, item.animIn.type, clamp(local / dIn, 0, 1), true);
  }
  if (item.animOut.type !== 'none' && dOut > 0 && local > item.duration - dOut) {
    applyAnim(pose, item, item.animOut.type, clamp((item.duration - local) / dOut, 0, 1), false);
  }
  return pose;
}

// ---------------------------------------------------------------------------
// Text textures

/** Canvas backing accepted for visible-preview text and off-screen rasterization. */
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;
let textVersion = 0;

/**
 * Estimates a supersampling factor covering base, keyframed, zoom, and motion
 * scale so cached text remains sharp at the largest likely displayed size.
 *
 * The result is quantized in quarter-log2 steps and bounded to avoid tiny or
 * unbounded raster canvases.
 */
function renderScaleFor(item: TextItem): number {
  let s = Math.abs(item.transform.scale);
  for (const k of item.keyframes) s = Math.max(s, Math.abs(k.scale));
  const zoomy = (a: AnimType) => a === 'zoomIn' || a === 'zoomOut' || a === 'pop';
  if (zoomy(item.animIn.type) || zoomy(item.animOut.type)) s *= 1.5;
  if (item.motion !== 'none') s *= 1.2;
  const q = Math.pow(2, Math.round(Math.log2(Math.max(s, 1e-3)) * 4) / 4);
  return clamp(q, 0.25, 6);
}

/**
 * Owns raster canvases for text items and invalidates them from an appearance
 * signature rather than render frequency.
 *
 * Each preview/export pass owns its own instance, while the module's global
 * version counter prevents stale GPU entries across instances. Canvas pixels
 * are regenerated only when text/style, frame size, scale, word highlight,
 * visible character count, font readiness, or word data changes.
 */
export class TextCache {
  private map = new Map<string, { canvas: AnyCanvas; sig: string; version: number; upscale: number; rs: number; used: number }>();
  private tick = 0;

  /** Allows preview/export to choose an HTML or worker/off-screen canvas factory. */
  constructor(private create: () => AnyCanvas = () => document.createElement('canvas')) {}

  /**
   * Returns a versioned texture reference and unscaled frame-pixel dimensions.
   *
   * `activeWord` and `chars` control caption highlighting/typewriter output.
   * Re-rendering increments a process-global version so Compositor uploads the
   * new pixels even when an item's id is unchanged.
   */
  get(item: TextItem, W: number, H: number, activeWord: number, chars: number | null) {
    const rs = renderScaleFor(item);
    const ready = isFontReady(item.style.font, item.style.weight, item.style.italic);
    const sig = JSON.stringify([item.text, item.style, W, H, rs, activeWord, chars, ready, item.words?.length ?? 0]);
    let e = this.map.get(item.id);
    if (!e) {
      e = { canvas: this.create(), sig: '', version: 0, upscale: 1, rs, used: 0 };
      this.map.set(item.id, e);
    }
    if (e.sig !== sig) {
      e.upscale = renderTextCanvas(e.canvas, {
        text: item.text,
        style: item.style,
        fontPx: item.style.size * Math.min(W, H) * rs,
        wrapPx: item.style.maxWidth * W * rs,
        words: item.words,
        activeWord,
        visibleChars: chars ?? undefined,
      });
      e.sig = sig;
      e.rs = rs;
      e.version = ++textVersion;
    }
    e.used = this.tick;
    const ref: TexRef = { key: 'txt:' + item.id, source: e.canvas, version: e.version };
    return { ref, w: (e.canvas.width * e.upscale) / rs, h: (e.canvas.height * e.upscale) / rs };
  }

  /**
   * Advances the logical use counter and removes entries unused for about 300
   * sweeps. The periodic check keeps per-frame cache maintenance small.
   */
  sweep() {
    this.tick++;
    if (this.tick % 300 !== 0) return;
    for (const [k, e] of this.map) if (this.tick - e.used > 300) this.map.delete(k);
  }

  /** Drops every canvas reference immediately; callers use it during engine disposal. */
  clear() {
    this.map.clear();
  }
}

// ---------------------------------------------------------------------------
// Frame building

/** Frame-pixel intrinsic layer size and normalized source UV rectangle. */
interface Base {
  w: number;
  h: number;
  uv: [number, number, number, number];
}

/**
 * Converts asset dimensions, crop, fit, and flip settings into a frame-pixel
 * layer size plus source UV rectangle. Crop dimensions are clamped away from
 * zero to avoid division/quad collapse.
 */
function baseSize(item: MainItem | OverlayItem, ctx: SceneContext): Base {
  const { W, H } = ctx;
  const c = item.crop;
  let aw = W;
  let ah = H;
  if (item.type !== 'color') {
    const a = ctx.asset(item.mediaId);
    if (a && a.width > 0 && a.height > 0) {
      aw = a.width;
      ah = a.height;
    }
  }
  const sw = aw * clamp(1 - c.l - c.r, 0.02, 1);
  const sh = ah * clamp(1 - c.t - c.b, 0.02, 1);
  const s = item.fit === 'fill' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh);
  let x0 = c.l;
  let x1 = 1 - c.r;
  let y0 = c.t;
  let y1 = 1 - c.b;
  if (item.flipH) [x0, x1] = [x1, x0];
  if (item.flipV) [y0, y1] = [y1, y0];
  return { w: sw * s, h: sh * s, uv: [x0, y0, x1, y1] };
}

/** Texture/matte pair resolved from a provider, with solid-color layers represented by `null`. */
interface ItemTexture {
  ref: TexRef;
  matte: TexRef | null;
}

/**
 * Resolves a media item's texture key and optional subject matte.
 *
 * `undefined` means the frame is still loading, while `null` represents an
 * intentional solid-color layer. Video source time is clamped to the decoded
 * asset endpoint to avoid seeking past the final frame.
 */
function itemTexture(item: MainItem | OverlayItem, t: number, ctx: SceneContext): ItemTexture | null | undefined {
  if (item.type === 'color') return null;
  if (item.type === 'image') {
    const frame = ctx.provider.image(item);
    return frame
      ? {
          ref: { key: 'img:' + item.mediaId, source: frame.source, version: frame.version, mip: true },
          matte: frame.matte
            ? { key: 'matte:img:' + item.mediaId, source: frame.matte.source, version: frame.matte.version }
            : null,
        }
      : undefined;
  }
  const a = ctx.asset(item.mediaId);
  let st = sourceTime(item, t);
  if (a) st = clamp(st, 0, Math.max(0, a.duration - 0.001));
  const f = ctx.provider.video(item, st);
  return f
    ? {
        ref: { key: 'vid:' + item.id, source: f.source, version: f.version },
        matte: f.matte
          ? { key: 'matte:vid:' + item.id, source: f.matte.source, version: f.matte.version }
          : null,
      }
    : undefined;
}

/**
 * Translates item pose/media state into GPU-ready layer parameters.
 *
 * Main-track blend is forced to normal, while overlays retain their configured
 * mode. Filter, shape mask, chroma key, and subject-matte settings are resolved
 * here so `Compositor` only consumes explicit draw values.
 */
function makeLayer(item: MainItem | OverlayItem, pose: Pose, base: Base, ctx: SceneContext, tex: ItemTexture | null, overlay: boolean): DrawLayer {
  const removal = readBackgroundRemoval(item);
  return {
    tex: tex?.ref ?? null,
    color: item.type === 'color' ? hexToRgb(item.color) : [0, 0, 0],
    cx: ctx.W / 2 + pose.x * ctx.W,
    cy: ctx.H / 2 + pose.y * ctx.H,
    w: base.w * pose.scale,
    h: base.h * pose.scale,
    rot: pose.rotation * DEG,
    uv: base.uv,
    opacity: clamp(pose.opacity, 0, 1),
    blend: overlay ? item.blend : 'normal',
    fx: computeFx(item),
    mask: item.mask.shape !== 'none' ? { ...item.mask } : null,
    chroma:
      removal.mode === 'color' && item.type !== 'color'
        ? { color: hexToRgb(removal.color), similarity: removal.similarity, smoothness: removal.smoothness }
        : null,
    cutout:
      removal.mode === 'subject' && item.type !== 'color'
        ? { matte: tex?.matte ?? null, feather: removal.feather }
        : null,
  };
}

/**
 * Conservatively determines whether an opaque, untransformed layer fills the
 * canvas. Returning false is safe (it merely enables a blurred backdrop);
 * rotations, alpha, masks, keying, and cutout all disqualify a layer.
 */
function covers(L: DrawLayer, W: number, H: number): boolean {
  const deg = (((L.rot / DEG) % 360) + 360) % 360;
  if (deg > 0.01 && deg < 359.99) return false;
  if (L.opacity < 0.999 || L.mask || L.chroma || L.cutout) return false;
  const hw = Math.abs(L.w) / 2;
  const hh = Math.abs(L.h) / 2;
  return L.cx - hw <= 0.5 && L.cx + hw >= W - 0.5 && L.cy - hh <= 0.5 && L.cy + hh >= H - 0.5;
}

/** Copies a resolved draw layer's identity and geometry into an editor hit-test record. */
function quadOf(id: string, kind: HitQuad['kind'], L: Pick<DrawLayer, 'cx' | 'cy' | 'w' | 'h' | 'rot'>): HitQuad {
  return { id, kind, cx: L.cx, cy: L.cy, w: Math.abs(L.w), h: Math.abs(L.h), rot: L.rot };
}

/**
 * Builds a selection quad at the rendered pose normally, but at the stable rest
 * pose while entrance/exit animation is active. This keeps an item grabbable
 * when a visible pop/zoom/spin pose is tiny or off to one side.
 */
function restQuad(
  id: string,
  kind: HitQuad['kind'],
  item: VisualItem,
  t: number,
  L: DrawLayer,
  baseW: number,
  baseH: number,
  ctx: SceneContext,
): HitQuad {
  if (!animating(item, t - item.start)) return quadOf(id, kind, L);
  const r = restPose(item, t);
  return quadOf(id, kind, {
    cx: ctx.W / 2 + r.x * ctx.W,
    cy: ctx.H / 2 + r.y * ctx.H,
    w: baseW * r.scale,
    h: baseH * r.scale,
    rot: r.rotation * DEG,
  });
}

/**
 * Resolves one main-track item into a page and registers its editor quad.
 *
 * A not-ready texture still produces a quad but an empty page. When a ready
 * image does not cover the output and blur mode is selected, a zoomed copy of
 * that layer (without masks/keying/cutout) is supplied as the backdrop.
 */
function mainPage(item: MainItem, t: number, p: Project, ctx: SceneContext, quads: HitQuad[]): Page {
  const pose = itemPose(item, t);
  const base = baseSize(item, ctx);
  const tex = itemTexture(item, t, ctx);
  const layer = makeLayer(item, pose, base, ctx, tex ?? null, false);
  quads.push(restQuad(item.id, 'main', item, t, layer, base.w, base.h, ctx));
  if (tex === undefined) return { background: null, layers: [] };
  let background: Page['background'] = null;
  if (p.background.mode === 'blur' && tex && !covers(layer, ctx.W, ctx.H)) {
    const s = Math.max(ctx.W / base.w, ctx.H / base.h);
    background = {
      blur: p.background.blur,
      layer: {
        ...layer,
        cx: ctx.W / 2,
        cy: ctx.H / 2,
        w: base.w * s,
        h: base.h * s,
        rot: 0,
        mask: null,
        chroma: null,
        cutout: null,
      },
    };
  }
  return { background, layers: [layer] };
}

/** Filters items active at `t`, clips endpoints with epsilon, and orders them by editor lane. */
function activeSorted<T extends { start: number; duration: number; lane: number }>(items: T[], t: number): T[] {
  return items.filter((it) => t >= it.start - EPS && t < itemEnd(it) - EPS).sort((a, b) => a.lane - b.lane);
}

/**
 * Rasterizes/resolves a text item and constructs its layer plus selection quad.
 *
 * Caption word time is converted from project to item-local time to select a
 * highlight, while typewriter character count comes from the animated pose.
 */
function textLayer(item: TextItem, t: number, ctx: SceneContext, quads: HitQuad[]): DrawLayer | null {
  const pose = itemPose(item, t);
  const local = t - item.start;
  let activeWord = -1;
  if (item.words?.length && item.style.highlightOn) {
    for (let i = 0; i < item.words.length; i++) {
      if (item.words[i].start <= local + EPS) activeWord = i;
      else break;
    }
  }
  const r = ctx.texts.get(item, ctx.W, ctx.H, activeWord, pose.chars);
  const L: DrawLayer = {
    tex: r.ref,
    color: [0, 0, 0],
    cx: ctx.W / 2 + pose.x * ctx.W,
    cy: ctx.H / 2 + pose.y * ctx.H,
    w: r.w * pose.scale,
    h: r.h * pose.scale,
    rot: pose.rotation * DEG,
    uv: [item.flipH ? 1 : 0, item.flipV ? 1 : 0, item.flipH ? 0 : 1, item.flipV ? 0 : 1],
    opacity: clamp(pose.opacity, 0, 1),
    blend: item.blend,
    fx: null,
    mask: null,
    chroma: null,
    cutout: null,
  };
  quads.push(restQuad(item.id, 'texts', item, t, L, r.w, r.h, ctx));
  return L;
}

/**
 * Builds every CPU-side draw command and editor hit quad for timeline time `t`.
 *
 * `activeMain` determines a one- or two-page scene; transition progress is
 * eased, then overlays and text are appended in lane order so they remain above
 * the main transition. Provider misses intentionally produce empty main pages
 * or omit overlay layers until the asynchronous owner supplies a frame. The
 * function performs no rendering and does not mutate `p`.
 */
export function buildFrame(p: Project, t: number, ctx: SceneContext): { spec: FrameSpec; quads: HitQuad[] } {
  const quads: HitQuad[] = [];
  const pages: Page[] = [];
  let transition: FrameSpec['transition'] = null;
  const am = activeMain(p.main, t);
  if (am) {
    const tr = am.b?.transition;
    if (am.b && tr && tr.type !== 'none') {
      pages.push(mainPage(am.a, t, p, ctx, quads), mainPage(am.b, t, p, ctx, quads));
      transition = { type: tr.type, progress: easeInOut(am.progress) };
    } else {
      pages.push(mainPage(am.b ?? am.a, t, p, ctx, quads));
    }
  }
  const layers: DrawLayer[] = [];
  for (const it of activeSorted(p.overlays, t)) {
    const pose = itemPose(it, t);
    const base = baseSize(it, ctx);
    const tex = itemTexture(it, t, ctx);
    const L = makeLayer(it, pose, base, ctx, tex ?? null, true);
    quads.push(restQuad(it.id, 'overlays', it, t, L, base.w, base.h, ctx));
    if (tex !== undefined) layers.push(L);
  }
  for (const it of activeSorted(p.texts, t)) {
    const L = textLayer(it, t, ctx, quads);
    if (L) layers.push(L);
  }
  ctx.texts.sweep();
  const clear = p.background.mode === 'color' ? hexToRgb(p.background.color) : ([0, 0, 0] as [number, number, number]);
  return {
    spec: { width: ctx.W, height: ctx.H, clear, pages, transition, layers, seed: ctx.seed },
    quads,
  };
}

/**
 * Tests a frame-pixel point in the inverse-rotated local space of a hit quad.
 *
 * `pad` expands every edge and is useful for touch targets; dimensions are
 * already normalized to positive values when the quad is produced.
 */
export function hitTest(q: HitQuad, px: number, py: number, pad = 0): boolean {
  const c = Math.cos(-q.rot);
  const s = Math.sin(-q.rot);
  const dx = px - q.cx;
  const dy = py - q.cy;
  const lx = dx * c - dy * s;
  const ly = dx * s + dy * c;
  return Math.abs(lx) <= q.w / 2 + pad && Math.abs(ly) <= q.h / 2 + pad;
}
