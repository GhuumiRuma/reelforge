/**
 * Main-thread coordinator for subject-background removal. It samples video or
 * image pixels into a bounded preview-size request, transfers that request to a
 * lazy worker, and caches the returned grayscale mattes for scene composition.
 */
import type { BackgroundRequest, BackgroundWorkerMessage } from './background.worker';

/** Remote model identifier used by the worker; changing it should also bump the cache version. */
export const BACKGROUND_MODEL = 'Xenova/modnet';
/** Cache namespace version, invalidating stale mattes after model or sampling changes. */
export const BACKGROUND_MODEL_VERSION = '1';
/** Number of source-time buckets per second used for stable video-frame matte reuse. */
export const SUBJECT_SAMPLE_RATE = 6;
const MAX_SIDE = 512;
const MAX_CACHE = 12;
const IDLE_MS = 120_000;

/** A grayscale alpha canvas plus a texture version token consumed by the compositor. */
export interface SubjectMatte {
  source: HTMLCanvasElement;
  version: string;
}

/** Process-wide UI status for model download, segmentation, completion, and failure. */
export interface BackgroundStatus {
  phase: 'idle' | 'download' | 'segment' | 'ready' | 'error';
  progress: number | null;
  loaded?: number;
  total?: number;
  message?: string;
}

/** Correlation state retained until a worker response or cancellation settles the request. */
interface Pending {
  resolve: (matte: SubjectMatte) => void;
  reject: (error: Error) => void;
  key: string;
  version: string;
  onProgress?: (status: BackgroundStatus) => void;
}

const listeners = new Set<(status: BackgroundStatus) => void>();
const cache = new Map<string, SubjectMatte>();
const pendingKeys = new Map<string, Promise<SubjectMatte>>();
const pending = new Map<number, Pending>();
let worker: Worker | null = null;
let requestId = 0;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let status: BackgroundStatus = { phase: 'idle', progress: null };

/** Returns the most recently published status object; callers should treat it as immutable. */
export function getBackgroundStatus(): BackgroundStatus {
  return status;
}

/**
 * Registers a process-wide status listener and returns an unsubscribe closure.
 * Subscribing does not replay `status`; listeners receive subsequent transitions.
 */
export function subscribeBackgroundStatus(listener: (status: BackgroundStatus) => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Publishes a status transition both to all active request callbacks and to
 * global subscribers. The object is not cloned, so notifications are read-only
 * snapshots owned by this module.
 */
function setStatus(next: BackgroundStatus) {
  status = next;
  for (const request of pending.values()) request.onProgress?.(next);
  for (const listener of listeners) listener(next);
}

/**
 * Maps low-level model/network errors to concise user guidance while retaining
 * unrecognized worker messages for diagnostics.
 */
function friendlyError(message: string): string {
  if (/fetch|network|failed to load|load model/i.test(message)) {
    return 'Could not download the cutout model. Check your connection and try again.';
  }
  if (/memory|allocation|oom/i.test(message)) {
    return 'Not enough memory to remove this background. Try a shorter clip or color key instead.';
  }
  return message || 'The background could not be removed.';
}

/** Terminates the idle/failed worker and rejects every still-correlated request. */
function killWorker() {
  clearTimeout(idleTimer);
  worker?.terminate();
  worker = null;
  for (const request of pending.values()) request.reject(new Error('Background removal was stopped'));
  pending.clear();
}

/**
 * Lazily creates the dedicated background-removal worker and attaches the
 * singleton message/error handlers. Responses are matched by request id; model
 * download messages have no id and update global status.
 *
 * Successful inference is expanded from grayscale alpha bytes into an RGBA
 * canvas because that is a directly uploadable `TexImageSource`.
 */
function getWorker(): Worker {
  clearTimeout(idleTimer);
  if (worker) return worker;
  worker = new Worker(new URL('./background.worker.ts', import.meta.url), { type: 'module', name: 'background-removal' });
  worker.onmessage = (event: MessageEvent<BackgroundWorkerMessage>) => {
    const message = event.data;
    if (message.type === 'load') {
      setStatus({ phase: 'download', progress: message.progress, loaded: message.loaded, total: message.total });
      return;
    }
    const request = pending.get('id' in message ? message.id : -1);
    if (!request) return;
    if (message.type === 'progress') {
      setStatus({ phase: 'segment', progress: message.progress });
    } else if (message.type === 'error') {
      pending.delete(message.id);
      const error = new Error(friendlyError(message.message));
      request.reject(error);
      setStatus({ phase: 'error', progress: null, message: error.message });
    } else {
      pending.delete(message.id);
      const canvas = document.createElement('canvas');
      canvas.width = message.width;
      canvas.height = message.height;
      const context = canvas.getContext('2d');
      if (!context) {
        const error = new Error('This device could not prepare the cutout preview.');
        request.reject(error);
        setStatus({ phase: 'error', progress: null, message: error.message });
        return;
      }
      const pixels = new Uint8ClampedArray(message.width * message.height * 4);
      for (let i = 0; i < message.matte.length; i++) {
        pixels[i * 4] = message.matte[i];
        pixels[i * 4 + 1] = message.matte[i];
        pixels[i * 4 + 2] = message.matte[i];
        pixels[i * 4 + 3] = 255;
      }
      context.putImageData(new ImageData(pixels, message.width, message.height), 0, 0);
      const matte = { source: canvas, version: request.version };
      remember(request.key, matte);
      request.resolve(matte);
      setStatus({ phase: 'ready', progress: 1 });
    }
  };
  worker.onerror = (event) => {
    const error = new Error(friendlyError(event.message || 'The cutout engine stopped unexpectedly.'));
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    worker?.terminate();
    worker = null;
    setStatus({ phase: 'error', progress: null, message: error.message });
  };
  return worker;
}

/**
 * Reads intrinsic dimensions across the browser image/video sources accepted by
 * WebGL. It deliberately ignores display/CSS sizing and is used before canvas
 * downscaling.
 */
function sourceSize(source: TexImageSource): [number, number] {
  if (typeof HTMLVideoElement !== 'undefined' && source instanceof HTMLVideoElement) return [source.videoWidth, source.videoHeight];
  if (typeof VideoFrame !== 'undefined' && source instanceof VideoFrame) return [source.displayWidth, source.displayHeight];
  if (typeof HTMLImageElement !== 'undefined' && source instanceof HTMLImageElement) return [source.naturalWidth, source.naturalHeight];
  const value = source as { width: number; height: number };
  return [value.width, value.height];
}

/**
 * Inserts a matte at the newest end of the LRU cache. The bounded count prevents
 * old canvases from retaining large image buffers indefinitely.
 */
function remember(key: string, matte: SubjectMatte) {
  cache.delete(key);
  cache.set(key, matte);
  while (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

/**
 * Rasterizes a ready `TexImageSource` to at most 512 px on its long side.
 *
 * The copy is required both to normalize WebCodecs/browser sources to RGBA and
 * to reduce model cost. A fresh buffer is returned and can be transferred to the
 * worker without detaching the caller's source canvas or video frame.
 */
function framePixels(source: TexImageSource): { data: Uint8ClampedArray; width: number; height: number } {
  const [width, height] = sourceSize(source);
  if (!width || !height) throw new Error('The clip frame is not ready yet.');
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
  const w = Math.max(2, Math.round(width * scale));
  const h = Math.max(2, Math.round(height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error('This device cannot prepare a cutout.');
  if (typeof ImageData !== 'undefined' && source instanceof ImageData) {
    const original = document.createElement('canvas');
    original.width = width;
    original.height = height;
    original.getContext('2d')?.putImageData(source, 0, 0);
    context.drawImage(original, 0, 0, w, h);
  } else {
    context.drawImage(source as CanvasImageSourceWebCodecs, 0, 0, w, h);
  }
  return { data: context.getImageData(0, 0, w, h).data, width: w, height: h };
}

/** Builds the model/versioned cache key; video time is quantized to `SUBJECT_SAMPLE_RATE` buckets. */
export function subjectMatteKey(mediaId: string, sourceTime: number | null): string {
  const frame = sourceTime === null ? 'still' : Math.round(sourceTime * SUBJECT_SAMPLE_RATE);
  return `${BACKGROUND_MODEL_VERSION}:${mediaId}:${frame}`;
}

/** Returns an exact cached matte without triggering inference, or `null` on a miss. */
export function peekSubjectMatte(key: string): SubjectMatte | null {
  return cache.get(key) ?? null;
}

/**
 * Reuses the exact or nearest analyzed frame within half a second of video time.
 * This is a read-only cache lookup that avoids a slow matte result flashing on
 * and off while playback crosses unprocessed sample buckets. Stills only use
 * their exact key.
 */
export function peekRecentSubjectMatte(mediaId: string, sourceTime: number | null): SubjectMatte | null {
  if (sourceTime === null) return peekSubjectMatte(subjectMatteKey(mediaId, null));
  const frame = Math.round(sourceTime * SUBJECT_SAMPLE_RATE);
  for (let distance = 0; distance <= SUBJECT_SAMPLE_RATE / 2; distance++) {
    const candidates = distance === 0 ? [frame] : [frame - distance, frame + distance];
    for (const near of candidates) {
      if (near < 0) continue;
      const matte = peekSubjectMatte(`${BACKGROUND_MODEL_VERSION}:${mediaId}:${near}`);
      if (matte) return matte;
    }
  }
  return null;
}

/** Reports whether any request remains correlated with a worker response. */
export function subjectMatteBusy(): boolean {
  return pending.size > 0;
}

/**
 * Returns a cached or newly inferred subject matte for the supplied frame.
 *
 * Equal keys are deduplicated into one worker task (sharing the first caller's
 * cancellation/progress behavior), while distinct tasks may be queued by the
 * worker. Cache hits refresh LRU order. On a miss, RGBA pixels are copied and
 * transferred (not shared) to the worker; resolution therefore costs
 * main-thread sampling once per unique key. An abort removes that request's
 * correlation and rejects with `AbortError`; already-running model work may
 * finish. Successful results are cached, and a post-settlement timeout later
 * terminates the worker to release model memory.
 */
export function subjectMatte(
  key: string,
  source: TexImageSource,
  options: { signal?: AbortSignal; onProgress?: (status: BackgroundStatus) => void } = {},
): Promise<SubjectMatte> {
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return Promise.resolve(cached);
  }
  const active = pendingKeys.get(key);
  if (active) return active;

  const version = `cutout:${key}`;
  const task = new Promise<SubjectMatte>((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new DOMException('Cancelled', 'AbortError'));
      return;
    }
    let input: ReturnType<typeof framePixels>;
    try {
      input = framePixels(source);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const id = ++requestId;
    const onAbort = () => {
      options.signal?.removeEventListener('abort', onAbort);
      pending.delete(id);
      reject(new DOMException('Cancelled', 'AbortError'));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    const finishResolve = (matte: SubjectMatte) => {
      options.signal?.removeEventListener('abort', onAbort);
      resolve(matte);
    };
    const finishReject = (error: Error) => {
      options.signal?.removeEventListener('abort', onAbort);
      reject(error);
    };
    pending.set(id, { resolve: finishResolve, reject: finishReject, key, version, onProgress: options.onProgress });
    options.onProgress?.({ phase: 'segment', progress: null });
    const request: BackgroundRequest = { type: 'run', id, rgba: input.data, width: input.width, height: input.height };
    getWorker().postMessage(request, [input.data.buffer]);
  });
  pendingKeys.set(key, task);
  const finish = () => {
    pendingKeys.delete(key);
    idleTimer = setTimeout(killWorker, IDLE_MS);
  };
  void task.then(finish, finish);
  return task;
}
