/**
 * Validates, suggests, and encodes audio-only excerpts from media already in the
 * project. The encoder deliberately reuses the normal audio mixer so fades,
 * speed changes, resampling, and channel mapping match the rest of the engine.
 */
import { ALL_FORMATS, AudioBufferSource, BlobSource, BufferTarget, Input, Mp4OutputFormat, Output, Quality } from 'mediabunny';
import type { MediaAsset, Project, VideoItem } from '../types';
import { audioItem, newProject } from '../lib/defaults';
import { itemEnd, MIN_DUR, sourceTime } from '../lib/layout';
import { getBlob } from '../lib/media';
import { clamp, formatClock, parseTime } from '../lib/util';
import { AudioMixer, canEncodeAac, encodeWav } from './audio';

/** End times typed up to this far past the end of the video snap to the end. */
const END_SLACK = 1;
const SUGGESTED_LENGTH = 5;
/** Chrome only shares .m4a files with this type. */
const M4A_TYPE = 'audio/x-m4a';

/** The normalized range of a valid form submission, or the field and message that must be corrected. */
export type SoundbiteCheck =
  | { ok: true; start: number; end: number }
  | { ok: false; field: 'start' | 'end'; error: string };

/** Rounds user-entered media times to hundredths to keep form values stable without discarding sub-second input. */
const round2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Parses and validates form times relative to a source video.
 *
 * Times are rounded to 0.01 s and the end may slightly exceed `duration` so a
 * typist can finish on the exact media endpoint. The result is purely derived:
 * it does not mutate the item and is suitable for driving field-level UI errors.
 */
export function checkSoundbite(startText: string, endText: string, duration: number): SoundbiteCheck {
  const s = parseTime(startText);
  if (s === null) return { ok: false, field: 'start', error: 'Type a start time like 42.5, or 102.5 for 1:02.5.' };
  const e = parseTime(endText);
  if (e === null) return { ok: false, field: 'end', error: 'Type an end time like 51, or 102.5 for 1:02.5.' };
  const start = round2(s);
  if (start >= duration) return { ok: false, field: 'start', error: `Start must be before the video ends at ${formatClock(duration)}.` };
  if (e > duration + END_SLACK) return { ok: false, field: 'end', error: `End can’t be after the video ends at ${formatClock(duration)}.` };
  const end = Math.min(duration, round2(e));
  if (end <= start) return { ok: false, field: 'end', error: 'End must be after the start.' };
  if (end - start < MIN_DUR - 1e-6) return { ok: false, field: 'end', error: 'Make the soundbite at least 0.1 seconds long.' };
  return { ok: true, start, end };
}

/**
 * Formats a valid typed time when a field loses focus (for example, "42.5" becomes
 * "00:42.5"). Invalid text is intentionally preserved; values in the endpoint
 * slack are displayed as the real duration.
 */
export function tidyTime(text: string, duration: number): string {
  const v = parseTime(text);
  if (v === null) return text;
  return formatClock(v > duration && v <= duration + END_SLACK ? duration : v);
}

/**
 * Chooses an initial five-second range without mutating the video item.
 *
 * If the playhead is inside the timeline item, the suggestion begins at that
 * source-frame time; otherwise it begins at the clip's in point. Both endpoints
 * are constrained to the decoded media duration, with a tenth-second start grid.
 */
export function suggestSoundbite(v: VideoItem, t: number, duration: number): { start: number; end: number } {
  const at = t >= v.start && t < itemEnd(v) ? sourceTime(v, t) : v.in;
  const latest = Math.max(0, Math.floor((duration - MIN_DUR) * 10 + 1e-6) / 10);
  const start = clamp(Math.floor(at * 10 + 1e-6) / 10, 0, latest);
  return { start, end: Math.min(duration, start + SUGGESTED_LENGTH) };
}

/** Cancellation and progress callbacks shared by the output encoders. */
interface Progress {
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

/** Format negotiated with the browser/AAC polyfill before constructing a buffer source. */
interface AacFormat {
  sampleRate: number;
  numberOfChannels: number;
  bitrate: number;
}

/** Signals that the requested interval yielded no non-null PCM mix blocks. */
export class NoSoundError extends Error {
  /** Creates the stable user-facing error used to reject silent excerpts. */
  constructor() {
    super('Couldn’t read the sound in this clip.');
  }
}

/**
 * Encodes the source interval `[start, end]` as a downloadable audio file.
 *
 * The function builds a one-track project so all mixing goes through the same
 * source-time, speed, and channel behavior as normal preview/export. It first
 * probes AAC and retains original 44.1 kHz/mono metadata when possible; a
 * non-cancellation AAC failure falls back to 16-bit PCM WAV. Progress covers
 * mixing/encoding, and an abort or silent input rejects without producing a file.
 */
export async function encodeSoundbite(asset: MediaAsset, start: number, end: number, opts: Progress & { name: string }): Promise<File> {
  const duration = end - start;
  const bite = audioItem(asset, 0, 'extracted');
  bite.in = start;
  bite.duration = duration;
  const p: Project = { ...newProject(opts.name), audios: [bite] };
  const { sampleRate, numberOfChannels } = await sourceFormat(asset);
  const frames = Math.max(1, Math.round(duration * sampleRate));
  const aac = { sampleRate, numberOfChannels, bitrate: numberOfChannels === 1 ? 128_000 : 192_000 };
  if (await canEncodeAac(aac)) {
    try {
      return new File([await encodeM4a(p, frames, aac, opts)], `${opts.name}.m4a`, { type: M4A_TYPE });
    } catch (e) {
      if (opts.signal?.aborted || e instanceof NoSoundError || (e as Error)?.name === 'AbortError') throw e;
      console.warn('AAC encoding failed, saving WAV instead', e);
    }
  }
  const pcm = Array.from({ length: numberOfChannels }, () => new Float32Array(frames));
  await mixBite(p, frames, sampleRate, numberOfChannels, opts, (data, off) => data?.forEach((d, c) => pcm[c].set(d, off)));
  return new File([encodeWav(pcm, sampleRate)], `${opts.name}.wav`, { type: 'audio/wav' });
}

/**
 * Runs the one-track mix in one-second windows and forwards each PCM block to
 * `take`, using the destination offset `off` and sample count `n`.
 *
 * This bounds peak memory and gives `AudioBufferSource` time to flush chunks.
 * The mixer is always disposed, cancellation is checked between windows, and at
 * least one non-null mix chunk is required. `take` may be asynchronous.
 */
async function mixBite(
  p: Project,
  frames: number,
  rate: number,
  ch: number,
  opts: Progress,
  take: (data: Float32Array[] | null, off: number, n: number) => unknown,
): Promise<void> {
  const mixer = new AudioMixer(() => p, rate, ch);
  try {
    let heard = false;
    for (let off = 0; off < frames; ) {
      if (opts.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const n = Math.min(rate, frames - off);
      const data = await mixer.mix(off / rate, n);
      heard ||= data !== null;
      await take(data, off, n);
      off += n;
      opts.onProgress?.(off / frames);
    }
    if (!heard) throw new NoSoundError();
  } finally {
    mixer.dispose();
  }
}

/**
 * Reads the primary track's format when the asset is WebCodecs-readable.
 *
 * Only the AAC-friendly 44.1 kHz and mono variants are retained; otherwise the
 * safe 48 kHz stereo defaults are returned. Probe failures are non-fatal, and
 * the temporary Mediabunny input is always disposed.
 */
async function sourceFormat(asset: MediaAsset): Promise<{ sampleRate: number; numberOfChannels: number }> {
  const out = { sampleRate: 48_000, numberOfChannels: 2 };
  // Clips WebCodecs can't read are decoded at 48 kHz instead (decodeWholeAudio).
  const blob = asset.canDecodeAudio ? await getBlob(asset.id) : null;
  if (!blob) return out;
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
  try {
    const track = await input.getPrimaryAudioTrack();
    if (track) {
      if ((await track.getSampleRate()) === 44_100) out.sampleRate = 44_100;
      if ((await track.getNumberOfChannels()) === 1) out.numberOfChannels = 1;
    }
  } catch {
    // Keep the defaults.
  } finally {
    input.dispose();
  }
  return out;
}

/**
 * Streams the mixed excerpt into an in-memory AAC/MP4 output and returns its
 * bytes. The output is finalized before its buffer is read; an incomplete encode
 * is cancelled in `finally` to release encoder resources.
 */
async function encodeM4a(p: Project, frames: number, fmt: AacFormat, opts: Progress): Promise<ArrayBuffer> {
  const { sampleRate: rate, numberOfChannels: ch } = fmt;
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const source = new AudioBufferSource({ codec: 'aac', quality: new Quality({ bitrate: fmt.bitrate }) });
  output.addAudioTrack(source);
  let finished = false;
  try {
    await output.start();
    await mixBite(p, frames, rate, ch, opts, async (data, _off, n) => {
      const buf = new AudioBuffer({ length: n, numberOfChannels: ch, sampleRate: rate });
      data?.forEach((d, c) => buf.copyToChannel(d as Float32Array<ArrayBuffer>, c));
      await source.add(buf);
    });
    source.close();
    await output.finalize();
    finished = true;
    const buffer = output.target.buffer;
    if (!buffer) throw new Error('Saving produced no data');
    return buffer;
  } finally {
    if (!finished) await output.cancel().catch(() => undefined);
  }
}
