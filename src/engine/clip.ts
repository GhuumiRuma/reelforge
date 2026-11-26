/**
 * Creates standalone clips with Mediabunny and generates media-library posters.
 * Re-encoding is reserved for operations that require exact trimming/cropping;
 * downloaded picture and sound streams are otherwise packet-muxed without loss.
 */
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  canEncodeAudio,
  Conversion,
  EncodedAudioPacketSource,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  getFirstEncodableVideoCodec,
  Output,
  WavOutputFormat,
  type InputAudioTrack,
  type InputVideoTrack,
} from 'mediabunny';
import { cropPixels, isFullCrop, type CropRect } from '../lib/clip';
import { canvasToBlob, loadVideoElement, seekElement } from '../lib/media';
import { canEncodeAac } from './audio';

/** Chrome only shares .m4a files with this type. */
const M4A_TYPE = 'audio/x-m4a';

/** User-selected cut parameters and optional cancellation/progress delivery. */
export interface ClipJob {
  kind: 'video' | 'audio';
  start: number;
  end: number;
  /** video only; fractions of the frame */
  crop?: CropRect;
  /** file name without extension */
  name: string;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

/** Output metadata accompanies the File so callers can update the library without probing it again. */
export interface ClipResult {
  file: File;
  width: number;
  height: number;
  duration: number;
}

/** A user-correctable clipping failure, distinct from unexpected browser/library errors. */
export class ClipError extends Error {}

/**
 * Cuts the requested source-time interval into a video or audio file.
 *
 * The Mediabunny input is shared by the selected encoder and disposed on every
 * path. Video jobs require a picture track; audio jobs require sound. Track
 * support and codec failures become `ClipError`s, while cancellation propagates
 * as `AbortError`.
 */
export async function encodeClip(source: Blob, job: ClipJob): Promise<ClipResult> {
  const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(source) });
  try {
    const video = job.kind === 'video' ? await input.getPrimaryVideoTrack() : null;
    const audio = await input.getPrimaryAudioTrack();
    if (job.kind === 'video' && !video) throw new ClipError('This file has no picture to clip. Save it as an audio clip instead.');
    if (job.kind === 'audio' && !audio) throw new ClipError('This file has no sound to clip.');
    if (job.kind === 'audio') return await encodeAudio(input, audio!, job);
    return await encodeVideo(input, video!, job);
  } finally {
    input.dispose();
  }
}

/**
 * Transcodes a primary video track at the clipped frame interval and optional
 * pixel crop. A primary audio track is included when AAC or Opus is available;
 * otherwise the result is intentionally silent rather than failing the video.
 *
 * The bitrate is bounded by device-friendly and maximum output limits. The
 * returned dimensions describe the cropped picture, not the source container.
 */
async function encodeVideo(input: Input, track: InputVideoTrack, job: ClipJob): Promise<ClipResult> {
  const srcW = track.displayWidth;
  const srcH = track.displayHeight;
  const crop = job.crop && !isFullCrop(job.crop) ? cropPixels(job.crop, srcW, srcH) : null;
  const width = crop?.width ?? srcW;
  const height = crop?.height ?? srcH;
  const bitrate = Math.max(2_000_000, Math.min(16_000_000, width * height * 4));
  const codec = await getFirstEncodableVideoCodec(['avc', 'hevc', 'vp9', 'av1'], { width, height, bitrate }).catch(() => null);
  if (!codec) throw new ClipError('This phone can’t encode video. Try updating it, or save an audio clip instead.');
  const audioOpts = { numberOfChannels: 2, sampleRate: 48_000, bitrate: 192_000 };
  const acodec = (await canEncodeAac(audioOpts)) ? 'aac' : (await canEncodeAudio('opus', audioOpts).catch(() => false)) ? 'opus' : null;
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const conversion = await Conversion.init({
    input,
    output,
    trim: { start: job.start, end: job.end },
    video: {
      ...(crop ? { crop } : {}),
      codec,
      bitrate,
      // Re-encoding cuts on the exact frame instead of the nearest key frame.
      forceTranscode: true,
    },
    audio: acodec ? { codec: acodec, bitrate: 192_000, forceTranscode: true } : { discard: true },
    tracks: 'primary',
    showWarnings: false,
  });
  if (!conversion.utilizedTracks.some((t) => t.isVideoTrack())) {
    throw new ClipError('This phone can’t encode video. Try updating it, or save an audio clip instead.');
  }
  await run(conversion, job);
  const buffer = output.target.buffer;
  if (!buffer) throw new ClipError('Saving produced no data.');
  return {
    file: new File([buffer], `${job.name}.mp4`, { type: 'video/mp4' }),
    width,
    height,
    duration: job.end - job.start,
  };
}

/**
 * Converts the primary audio track to AAC/M4A when supported, otherwise PCM
 * WAV. Format selection limits channels to stereo and sample rate to 44.1 or
 * 48 kHz, avoiding unsupported codec configurations while preserving common
 * source formats.
 */
async function encodeAudio(input: Input, track: InputAudioTrack, job: ClipJob): Promise<ClipResult> {
  const numberOfChannels = Math.min(2, track.numberOfChannels || 2);
  const sampleRate = track.sampleRate === 44_100 ? 44_100 : 48_000;
  const aac = await canEncodeAac({ numberOfChannels, sampleRate, bitrate: 192_000 });
  const output = aac
    ? new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() })
    : new Output({ format: new WavOutputFormat(), target: new BufferTarget() });
  const conversion = await Conversion.init({
    input,
    output,
    trim: { start: job.start, end: job.end },
    video: { discard: true },
    audio: aac
      ? { codec: 'aac', numberOfChannels, sampleRate, bitrate: 192_000, forceTranscode: true }
      : { codec: 'pcm-s16', numberOfChannels, sampleRate, forceTranscode: true },
    tracks: 'primary',
    showWarnings: false,
  });
  if (!conversion.utilizedTracks.length) throw new ClipError('Couldn’t read the sound in this file.');
  await run(conversion, job);
  const buffer = output.target.buffer;
  if (!buffer) throw new ClipError('Saving produced no data.');
  const file = aac ? new File([buffer], `${job.name}.m4a`, { type: M4A_TYPE }) : new File([buffer], `${job.name}.wav`, { type: 'audio/wav' });
  return { file, width: 0, height: 0, duration: job.end - job.start };
}

/**
 * Executes one already-configured Mediabunny conversion.
 *
 * Progress is normalized from encoder media time into the requested clip
 * duration. An abort cancels the conversion; the event listener is removed in
 * all cases so a later abort cannot retain or affect a completed job.
 */
async function run(conversion: Conversion, job: ClipJob): Promise<void> {
  if (!conversion.isValid) throw new ClipError('This file can’t be converted on this device.');
  const length = Math.max(0.001, job.end - job.start);
  conversion.onProgress = (_p, t) => job.onProgress?.(Math.min(1, t / length));
  const abort = () => void conversion.cancel();
  job.signal?.addEventListener('abort', abort);
  try {
    if (job.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    await conversion.execute();
    if (job.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  } finally {
    job.signal?.removeEventListener('abort', abort);
  }
}

/**
 * Packet-muxes a picture-only download with an optional sound-only download.
 *
 * Decoder configs and track rotation are copied to the MP4, while encoded
 * packets pass through without decode/re-encode. Cancellation is checked for
 * every packet. A partial output is cancelled and both demuxer inputs are
 * disposed if any step fails.
 */
export async function muxStreams(videoBlob: Blob, audioBlob: Blob | null, signal?: AbortSignal): Promise<Blob> {
  const vIn = new Input({ formats: ALL_FORMATS, source: new BlobSource(videoBlob) });
  const aIn = audioBlob ? new Input({ formats: ALL_FORMATS, source: new BlobSource(audioBlob) }) : null;
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  let finished = false;
  try {
    const vTrack = await vIn.getPrimaryVideoTrack();
    const aTrack = aIn ? await aIn.getPrimaryAudioTrack() : null;
    const vCodec = vTrack ? await vTrack.getCodec() : null;
    const aCodec = aTrack ? await aTrack.getCodec() : null;
    if (!vTrack || !vCodec) throw new ClipError('The downloaded video has no picture.');
    const vSource = new EncodedVideoPacketSource(vCodec);
    output.addVideoTrack(vSource, { rotation: await vTrack.getRotation() });
    const aSource = aTrack && aCodec ? new EncodedAudioPacketSource(aCodec) : null;
    if (aSource) output.addAudioTrack(aSource);
    await output.start();

    const vConfig = await vTrack.getDecoderConfig();
    let first = true;
    for await (const packet of new EncodedPacketSink(vTrack).packets()) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      await vSource.add(packet, first && vConfig ? { decoderConfig: vConfig } : undefined);
      first = false;
    }
    vSource.close();
    if (aSource && aTrack) {
      const aConfig = await aTrack.getDecoderConfig();
      first = true;
      for await (const packet of new EncodedPacketSink(aTrack).packets()) {
        if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        await aSource.add(packet, first && aConfig ? { decoderConfig: aConfig } : undefined);
        first = false;
      }
      aSource.close();
    }
    await output.finalize();
    finished = true;
    const buffer = output.target.buffer;
    if (!buffer) throw new ClipError('Joining the download produced no data.');
    return new Blob([buffer], { type: 'video/mp4' });
  } finally {
    if (!finished) await output.cancel().catch(() => undefined);
    vIn.dispose();
    aIn?.dispose();
  }
}

/**
 * Seeks a temporary video element to `t` and encodes a maximum-320-px JPEG
 * thumbnail. The time is clamped away from the endpoint to avoid empty frames.
 *
 * Decode/seek/encode failures are reported as a warning and return `null`; the
 * object URL and temporary element source are released regardless.
 */
export async function posterFrame(blob: Blob, t: number): Promise<Blob | null> {
  const url = URL.createObjectURL(blob);
  try {
    const v = await loadVideoElement(url);
    await seekElement(v, Math.min(Math.max(0, t), Math.max(0, v.duration - 0.05)));
    const s = Math.min(1, 320 / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(v.videoWidth * s));
    c.height = Math.max(1, Math.round(v.videoHeight * s));
    c.getContext('2d')?.drawImage(v, 0, 0, c.width, c.height);
    v.removeAttribute('src');
    v.load();
    return await canvasToBlob(c, 'image/jpeg', 0.7);
  } catch (e) {
    console.warn('Could not make a poster frame', e);
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
