/**
 * Dedicated background-removal worker. It owns the model/WASM allocation,
 * serializes inference to protect worker memory, and reports structured-cloned
 * grayscale alpha results to the main-thread coordinator.
 */
import { env, pipeline, RawImage } from '@huggingface/transformers';

/** Main-thread request containing transferable RGBA pixels plus an unambiguous correlation id. */
export interface BackgroundRequest {
  type: 'run';
  id: number;
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
}

/** Download, per-request progress, success, and failure protocol sent back to the coordinator. */
export type BackgroundWorkerMessage =
  | { type: 'load'; progress: number; loaded: number; total: number }
  | { type: 'progress'; id: number; progress: number }
  | { type: 'result'; id: number; matte: Uint8Array; width: number; height: number }
  | { type: 'error'; id: number; message: string };

/** The pipeline shape accepted by this module after Transformers' generic type erasure. */
type Remover = (image: RawImage) => Promise<RawImage>;

env.allowLocalModels = false;

/** Posts one structured protocol message; kept local so all worker output has the same boundary. */
const post = (message: BackgroundWorkerMessage) => self.postMessage(message);

let loaded: Promise<Remover> | null = null;
let queue = Promise.resolve();

/**
 * Lazily downloads and initializes the quantized WASM segmentation pipeline.
 *
 * The promise is shared for the worker lifetime to prevent concurrent model
 * allocation. Download progress is normalized to 0..1. A rejected load clears
 * the singleton so the next queued request can retry.
 */
function load(): Promise<Remover> {
  loaded ??= (pipeline as unknown as (task: string, model: string, options: Record<string, unknown>) => Promise<Remover>)(
    'background-removal',
    'Xenova/modnet',
    {
      device: 'wasm',
      dtype: 'q8',
      progress_callback: (event: { status: string; progress?: number; loaded?: number; total?: number }) => {
        if (event.status === 'progress_total') {
          post({
            type: 'load',
            progress: (event.progress ?? 0) / 100,
            loaded: event.loaded ?? 0,
            total: event.total ?? 0,
          });
        }
      },
    },
  );
  loaded.catch(() => {
    loaded = null;
  });
  return loaded;
}

/**
 * Runs one request and posts its alpha plane.
 *
 * The worker validates that the model preserved dimensions/channel count; it
 * then copies channel 3 (alpha) into a compact grayscale matte. The result
 * buffer is structured-cloned by postMessage, while `request.rgba` is already
 * detached by the main thread's incoming transfer.
 */
async function run(request: BackgroundRequest) {
  const remover = await load();
  post({ type: 'progress', id: request.id, progress: 0 });
  const output = await remover(new RawImage(request.rgba, request.width, request.height, 4));
  if (output.channels !== 4 || output.width !== request.width || output.height !== request.height) {
    throw new Error('The cutout model returned an unexpected image');
  }
  const matte = new Uint8Array(request.width * request.height);
  for (let i = 0; i < matte.length; i++) matte[i] = output.data[i * 4 + 3];
  post({ type: 'result', id: request.id, matte, width: output.width, height: output.height });
}

/**
 * Worker message entry point. Runs are chained through `queue` so only one model
 * invocation touches WASM memory at a time; a failed request is reported by id
 * and does not prevent the next queued request from running.
 */
self.onmessage = (event: MessageEvent<BackgroundRequest>) => {
  if (event.data?.type !== 'run') return;
  const request = event.data;
  queue = queue
    .then(() => run(request))
    .catch((error: unknown) => {
      post({ type: 'error', id: request.id, message: error instanceof Error ? error.message : String(error) });
    });
};
