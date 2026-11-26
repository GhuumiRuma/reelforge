/**
 * Worker-side speech recognition for the caption pipeline. It owns the
 * Transformers model, performs silence-aware chunking to fit WASM inference
 * limits, and converts model word timestamps back to project-relative seconds.
 */
import { env, pipeline } from '@huggingface/transformers';

/** Whisper model sizes accepted by the lazy pipeline loader. */
export type CaptionModel = 'tiny' | 'base';

/** Untyped-to-typed recognizer token shape before main-thread normalization. */
export interface RawWord {
  text: string;
  start: number;
  end: number;
}

/** One worker invocation and its transferred, resampled PCM contract. */
export interface CaptionRequest {
  type: 'run';
  /** 16 kHz mono PCM */
  audio: Float32Array;
  model: CaptionModel;
  /** ISO code, or null to auto-detect */
  language: string | null;
  task: 'transcribe' | 'translate';
}

/** Download, transcription, result, and error protocol sent to the main thread. */
export type CaptionWorkerMessage =
  | { type: 'load'; progress: number; loaded: number; total: number }
  | { type: 'progress'; progress: number }
  | { type: 'result'; words: RawWord[] }
  | { type: 'error'; message: string };

const SR = 16000;
const FRAME = SR / 50; // 20 ms analysis frames
const SILENCE_RMS = 0.004;

env.allowLocalModels = false;

/** ASR pipeline callback options and output shapes used after Transformers' generic type erasure. */
type Chunk = { text: string; timestamp: [number, number | null] };
/** A single model response, with optional word/chunk timestamps. */
type AsrOutput = { text: string; chunks?: Chunk[] };
/** Typed callable surface of the generic Transformers automatic-speech-recognition pipeline. */
type Asr = (audio: Float32Array, opts: Record<string, unknown>) => Promise<AsrOutput | AsrOutput[]>;

let loaded: { id: string; asr: Promise<Asr> } | null = null;

/** Posts every worker event through the single typed message boundary. */
const post = (m: CaptionWorkerMessage) => (self as unknown as { postMessage(m: CaptionWorkerMessage): void }).postMessage(m);

/**
 * Lazily constructs and caches the requested quantized WASM Whisper pipeline.
 *
 * The cache is one-entry because requests generally reuse a model, and model
 * download progress is normalized to 0..1. A failed promise clears itself only
 * if it is still the active cache entry, allowing a later request to retry.
 */
function load(model: CaptionModel): Promise<Asr> {
  const id = `onnx-community/whisper-${model}_timestamped`;
  if (loaded?.id === id) return loaded.asr;
  const asr = (pipeline as unknown as (task: string, model: string, opts: Record<string, unknown>) => Promise<Asr>)(
    'automatic-speech-recognition',
    id,
    {
      device: 'wasm',
      dtype: 'q8',
      progress_callback: (e: { status: string; progress?: number; loaded?: number; total?: number }) => {
        if (e.status === 'progress_total') {
          post({ type: 'load', progress: (e.progress ?? 0) / 100, loaded: e.loaded ?? 0, total: e.total ?? 0 });
        }
      },
    },
  );
  loaded = { id, asr };
  asr.catch(() => {
    if (loaded?.asr === asr) loaded = null;
  });
  return asr;
}

/**
 * Splits PCM into at most 28-second regions, choosing a cut in the 16-28 second
 * range with the lowest 15-frame RMS sum. Regions whose peak is below the
 * silence threshold are tagged for skip.
 *
 * RMS is measured in 20 ms frames to keep the O(audio length) search and
 * model calls bounded. Cut indices remain on frame boundaries, then convert back
 * to sample offsets for extraction.
 */
function segment(audio: Float32Array): { a: number; b: number; silent: boolean }[] {
  const n = Math.ceil(audio.length / FRAME);
  const rms = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = i * FRAME;
    const b = Math.min(audio.length, a + FRAME);
    let s = 0;
    for (let j = a; j < b; j++) s += audio[j] * audio[j];
    rms[i] = Math.sqrt(s / Math.max(1, b - a));
  }
  const MAX = 28 * 50;
  const MIN = 16 * 50;
  const WIN = 15;
  const cuts: [number, number][] = [];
  let start = 0;
  while (start < n) {
    if (n - start <= MAX) {
      cuts.push([start, n]);
      break;
    }
    let best = start + MAX;
    let bestV = Infinity;
    for (let i = start + MIN; i < start + MAX - WIN; i++) {
      let v = 0;
      for (let k = 0; k < WIN; k++) v += rms[i + k];
      if (v < bestV) {
        bestV = v;
        best = i + (WIN >> 1);
      }
    }
    cuts.push([start, best]);
    start = best;
  }
  return cuts.map(([a, b]) => {
    let peak = 0;
    for (let i = a; i < b; i++) peak = Math.max(peak, rms[i]);
    return { a: a * FRAME, b: Math.min(audio.length, b * FRAME), silent: peak < SILENCE_RMS };
  });
}

/**
 * Runs word-timestamp ASR for each non-silent segment in sequence.
 *
 * Model timestamps are segment-relative, so this adds the segment offset and
 * clamps/repairs bounds before posting `RawWord`s in project time. Progress is
 * weighted by non-silent sample count, not segment count. The entire request
 * rejects through the worker message protocol on model or inference failure.
 */
async function run(req: CaptionRequest) {
  const asr = await load(req.model);
  const segs = segment(req.audio);
  const total = segs.reduce((s, x) => s + (x.silent ? 0 : x.b - x.a), 0) || 1;
  let done = 0;
  const words: RawWord[] = [];
  post({ type: 'progress', progress: 0 });
  for (const s of segs) {
    if (s.silent) continue;
    const off = s.a / SR;
    const segEnd = s.b / SR;
    const opts: Record<string, unknown> = { return_timestamps: 'word', task: req.task };
    if (req.language) opts.language = req.language;
    let out = await asr(req.audio.slice(s.a, s.b), opts);
    if (Array.isArray(out)) out = out[0];
    for (const c of out?.chunks ?? []) {
      const [ws, we] = c.timestamp;
      const start = Math.min(segEnd, off + (ws ?? 0));
      const end = Math.min(segEnd, Math.max(start + 0.05, off + (we ?? (ws ?? 0) + 0.3)));
      words.push({ text: c.text, start, end });
    }
    done += s.b - s.a;
    post({ type: 'progress', progress: done / total });
  }
  post({ type: 'result', words });
}

/**
 * Worker entry point. Non-run messages are ignored, and asynchronous failures
 * are converted to a typed error message instead of escaping the worker.
 */
self.onmessage = (e: MessageEvent<CaptionRequest>) => {
  if (e.data?.type !== 'run') return;
  run(e.data).catch((err: unknown) => {
    post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  });
};
