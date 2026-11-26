/**
 * Narrow imperative bridge between React UI commands and the active preview engine.
 * Zustand owns editor/playhead state; this module only exposes the non-React engine
 * and clamps user seeks against the current project's derived duration.
 */
import type { PreviewEngine } from '../engine/preview';
import { projectDuration } from '../lib/layout';
import { clamp } from '../lib/util';
import { useEditor, useTime } from './store';

let engine: PreviewEngine | null = null;

/**
 * Registers the mounted preview engine, or clears it while the editor unmounts.
 * UI controls therefore never need to keep a direct engine instance themselves.
 */
export function setEngine(e: PreviewEngine | null) {
  engine = e;
}

/** Returns the live engine used by playback, preview, and audio-gesture commands. */
export function getEngine(): PreviewEngine | null {
  return engine;
}

/** Computes the current project duration from normalized project timing. */
export function duration(): number {
  const p = useEditor.getState().project;
  return p ? projectDuration(p) : 0;
}

/**
 * Moves both the reactive playhead and the imperative preview to `t`, clamped to
 * the project's valid range. This keeps a seek visible immediately even while the
 * engine is not playing.
 */
export function seek(t: number) {
  const tt = clamp(t, 0, duration());
  useTime.setState({ time: tt });
  engine?.seek(tt);
}

/** Reads the engine clock while playing and the Zustand clock while paused. */
export function now(): number {
  return engine?.playing ? engine.time : useTime.getState().time;
}

/** Toggles playback; callers must invoke it directly from a tap on iOS. */
export function togglePlay() {
  engine?.toggle();
}

/** Pauses the active engine without changing the editor's current playhead. */
export function pause() {
  engine?.pause();
}
