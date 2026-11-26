/**
 * Procedural sound-effects catalog. Each definition schedules Web Audio nodes
 * into an offline graph; rendered stereo PCM is then encoded as WAV and imported
 * through the same media store used for user files.
 */
import type { MediaAsset } from '../types';
import { getBlob, importFiles } from '../lib/media';
import { encodeWav } from './audio';

/**
 * A sound recipe receives a fresh offline context and a compressor-fed output.
 * It schedules all source/filter/gain nodes relative to the context timeline
 * and returns immediately; nodes need not be manually disposed because the
 * context ends after the catalogued duration.
 */
type Builder = (ctx: OfflineAudioContext, out: AudioNode) => void;

/** UI/import metadata plus the scheduling callback for one generated effect. */
interface SfxDef {
  id: string;
  name: string;
  emoji: string;
  duration: number;
  build: Builder;
}

/**
 * Creates a mono white-noise buffer of the requested duration at the context
 * sample rate. Random samples are generated eagerly and the source is returned
 * unstarted so the caller can place/filter it in its own graph.
 */
function noise(ctx: OfflineAudioContext, seconds: number): AudioBufferSourceNode {
  const len = Math.max(1, Math.round(seconds * ctx.sampleRate));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const n = ctx.createBufferSource();
  n.buffer = buf;
  return n;
}

/**
 * Creates an exponential attack/decay gain envelope. A non-zero floor avoids
 * invalid exponential ramps to zero; the returned node remains unconnected.
 */
function env(ctx: OfflineAudioContext, at: number, attack: number, peak: number, decay: number): GainNode {
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(peak, at + Math.max(0.001, attack));
  g.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  return g;
}

/**
 * Schedules one oscillator through a gain envelope into `out`.
 *
 * Frequencies may ramp from `f0` to `f1`; the source stops after the attack,
 * decay, and a short tail, so the offline render has no live source beyond the
 * declared sound duration.
 */
function tone(ctx: OfflineAudioContext, out: AudioNode, type: OscillatorType, f0: number, f1: number, at: number, dur: number, peak: number, attack = 0.003) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, at);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, at + dur);
  const g = env(ctx, at, attack, peak, dur);
  o.connect(g).connect(out);
  o.start(at);
  o.stop(at + attack + dur + 0.02);
}

/**
 * Built-in effect catalog. `duration` bounds the offline render, while each
 * `build` callback contributes its layered oscillators/noise to the shared
 * compressor output. The randomized glitch/click recipes are intentionally
 * non-deterministic per generation.
 */
export const SFX: SfxDef[] = [
  {
    id: 'pop',
    name: 'Pop',
    emoji: '🫧',
    duration: 0.25,
    /** A short downward sine sweep supplies the soft impact and quick tail. */
    build: (ctx, out) => tone(ctx, out, 'sine', 900, 260, 0, 0.12, 0.9, 0.002),
  },
  {
    id: 'click',
    name: 'Click',
    emoji: '🖱️',
    duration: 0.12,
    /** High-passed noise adds the transient while a high sine adds a crisp tick. */
    build: (ctx, out) => {
      const n = noise(ctx, 0.05);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 2500;
      n.connect(hp).connect(env(ctx, 0, 0.001, 0.8, 0.03)).connect(out);
      n.start(0);
      tone(ctx, out, 'sine', 2200, 1800, 0, 0.03, 0.4, 0.001);
    },
  },
  {
    id: 'whoosh',
    name: 'Whoosh',
    emoji: '💨',
    duration: 0.9,
    /** Band-passed noise opens and closes in frequency under a rounded gain arc. */
    build: (ctx, out) => {
      const n = noise(ctx, 0.9);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 1.2;
      bp.frequency.setValueAtTime(300, 0);
      bp.frequency.exponentialRampToValueAtTime(3200, 0.38);
      bp.frequency.exponentialRampToValueAtTime(500, 0.85);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, 0);
      g.gain.exponentialRampToValueAtTime(1.2, 0.35);
      g.gain.exponentialRampToValueAtTime(0.0001, 0.88);
      n.connect(bp).connect(g).connect(out);
      n.start(0);
    },
  },
  {
    id: 'ding',
    name: 'Ding',
    emoji: '🔔',
    duration: 1.6,
    /** Three detuned-length harmonic partials produce a bell-like long decay. */
    build: (ctx, out) => {
      tone(ctx, out, 'sine', 1318.5, 1318.5, 0, 1.5, 0.55, 0.004);
      tone(ctx, out, 'sine', 2637, 2637, 0, 0.8, 0.18, 0.004);
      tone(ctx, out, 'triangle', 3955, 3955, 0, 0.3, 0.06, 0.002);
    },
  },
  {
    id: 'notify',
    name: 'Notify',
    emoji: '📲',
    duration: 0.7,
    /** Two clean sine notes make a compact, staggered notification chime. */
    build: (ctx, out) => {
      tone(ctx, out, 'sine', 880, 880, 0, 0.25, 0.5);
      tone(ctx, out, 'sine', 1320, 1320, 0.13, 0.5, 0.5);
    },
  },
  {
    id: 'boom',
    name: 'Boom',
    emoji: '💥',
    duration: 1.5,
    /** A deep sine descent is reinforced by low-passed decaying noise. */
    build: (ctx, out) => {
      tone(ctx, out, 'sine', 120, 38, 0, 1.3, 1, 0.005);
      const n = noise(ctx, 1.2);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(1800, 0);
      lp.frequency.exponentialRampToValueAtTime(120, 0.9);
      n.connect(lp).connect(env(ctx, 0, 0.004, 0.9, 1.1)).connect(out);
      n.start(0);
    },
  },
  {
    id: 'drop',
    name: 'Bass drop',
    emoji: '🔊',
    duration: 1.8,
    /** One long sine frequency sweep recreates a bass-drop pitch fall. */
    build: (ctx, out) => tone(ctx, out, 'sine', 160, 32, 0, 1.7, 1, 0.01),
  },
  {
    id: 'rise',
    name: 'Riser',
    emoji: '🚀',
    duration: 2.2,
    /** Saw and high-passed noise rise in pitch/filter/gain before a sharp endpoint cut. */
    build: (ctx, out) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(180, 0);
      o.frequency.exponentialRampToValueAtTime(1800, 2.1);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(400, 0);
      lp.frequency.exponentialRampToValueAtTime(6000, 2.1);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, 0);
      g.gain.exponentialRampToValueAtTime(0.35, 2.05);
      g.gain.linearRampToValueAtTime(0, 2.2);
      o.connect(lp).connect(g).connect(out);
      o.start(0);
      o.stop(2.2);
      const n = noise(ctx, 2.2);
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.setValueAtTime(800, 0);
      hp.frequency.exponentialRampToValueAtTime(5000, 2.1);
      const g2 = ctx.createGain();
      g2.gain.setValueAtTime(0.0001, 0);
      g2.gain.exponentialRampToValueAtTime(0.4, 2.05);
      g2.gain.linearRampToValueAtTime(0, 2.2);
      n.connect(hp).connect(g2).connect(out);
      n.start(0);
    },
  },
  {
    id: 'glitch',
    name: 'Glitch',
    emoji: '👾',
    duration: 0.5,
    /** Random square-wave blips are scheduled densely across the first 420 ms. */
    build: (ctx, out) => {
      let t = 0;
      while (t < 0.42) {
        const f = 120 + Math.random() * 1600;
        tone(ctx, out, 'square', f, f, t, 0.03, 0.25, 0.001);
        t += 0.03 + Math.random() * 0.03;
      }
    },
  },
  {
    id: 'shutter',
    name: 'Camera',
    emoji: '📸',
    duration: 0.35,
    /** Two band-passed noise bursts model the mechanical shutter/capture pair. */
    build: (ctx, out) => {
      for (const at of [0, 0.09]) {
        const n = noise(ctx, 0.08);
        const bp = ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 3000;
        bp.Q.value = 0.8;
        n.connect(bp).connect(env(ctx, at, 0.001, 1, 0.06)).connect(out);
        n.start(at);
      }
    },
  },
  {
    id: 'boing',
    name: 'Boing',
    emoji: '🤪',
    duration: 0.8,
    /** An LFO modulates oscillator pitch while the base note springs upward. */
    build: (ctx, out) => {
      const o = ctx.createOscillator();
      o.type = 'sine';
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 14;
      const depth = ctx.createGain();
      depth.gain.setValueAtTime(90, 0);
      depth.gain.exponentialRampToValueAtTime(5, 0.7);
      lfo.connect(depth).connect(o.frequency);
      o.frequency.setValueAtTime(220, 0);
      o.frequency.exponentialRampToValueAtTime(330, 0.7);
      o.connect(env(ctx, 0, 0.005, 0.7, 0.7)).connect(out);
      o.start(0);
      lfo.start(0);
      o.stop(0.8);
      lfo.stop(0.8);
    },
  },
  {
    id: 'tada',
    name: 'Ta-da',
    emoji: '🎉',
    duration: 1.4,
    /** Four staggered major-chord triangle notes form an arpeggiated flourish. */
    build: (ctx, out) => {
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((f, i) => tone(ctx, out, 'triangle', f, f, i * 0.07, 1.1 - i * 0.05, 0.28, 0.005));
    },
  },
];

/** Fixed render/import sample rate; two channels are encoded even for mono recipes. */
const RATE = 48000;

/**
 * Renders a catalog entry into a 48 kHz stereo WAV blob.
 *
 * A two-channel offline context and master compressor limit cross-recipe
 * peaks. This does not register media or persist anything, making repeated calls
 * deterministic in duration but potentially randomized in noise/glitch content.
 */
export async function renderSfx(id: string): Promise<Blob> {
  const def = SFX.find((s) => s.id === id);
  if (!def) throw new Error('Unknown sound');
  const Ctx = window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext: typeof OfflineAudioContext }).webkitOfflineAudioContext;
  const ctx = new Ctx(2, Math.ceil(def.duration * RATE), RATE);
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -6;
  comp.connect(ctx.destination);
  def.build(ctx, comp);
  const buf = await ctx.startRendering();
  return encodeWav([buf.getChannelData(0), buf.getChannelData(1)], RATE);
}

/** Session cache of imported assets, used to avoid duplicate library entries across repeated taps. */
const imported = new Map<string, MediaAsset>();

/**
 * Generates and imports a sound into the media library.
 *
 * A cached asset is reused only while its blob still exists; otherwise the
 * function renders a fresh WAV and delegates persistence/ID generation to
 * `importFiles`. It rejects with the import failure or for an unknown id.
 */
export async function importSfx(id: string): Promise<MediaAsset> {
  const prev = imported.get(id);
  if (prev && (await getBlob(prev.id))) return prev;
  const def = SFX.find((s) => s.id === id)!;
  const blob = await renderSfx(id);
  const file = new File([blob], `${def.name}.wav`, { type: 'audio/wav' });
  const { assets, errors } = await importFiles([file]);
  if (!assets[0]) throw new Error(errors[0] ?? 'Could not create sound');
  imported.set(id, assets[0]);
  return assets[0];
}
