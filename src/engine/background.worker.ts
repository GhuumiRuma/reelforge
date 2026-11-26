import { env, pipeline, RawImage } from '@huggingface/transformers';

export interface BackgroundRequest {
  type: 'run';
  id: number;
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
}

export type BackgroundWorkerMessage =
  | { type: 'load'; progress: number; loaded: number; total: number }
  | { type: 'progress'; id: number; progress: number }
  | { type: 'result'; id: number; matte: Uint8Array; width: number; height: number }
  | { type: 'error'; id: number; message: string };

type Remover = (image: RawImage) => Promise<RawImage>;

env.allowLocalModels = false;

const post = (message: BackgroundWorkerMessage) => self.postMessage(message);

let loaded: Promise<Remover> | null = null;
let queue = Promise.resolve();

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

self.onmessage = (event: MessageEvent<BackgroundRequest>) => {
  if (event.data?.type !== 'run') return;
  const request = event.data;
  queue = queue
    .then(() => run(request))
    .catch((error: unknown) => {
      post({ type: 'error', id: request.id, message: error instanceof Error ? error.message : String(error) });
    });
};
