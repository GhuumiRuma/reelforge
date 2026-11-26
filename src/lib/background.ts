/**
 * Validation, normalization, and legacy migration for visual background-removal settings.
 *
 * The persisted model supports off, color-key, and subject modes, while older projects only have
 * the `chroma` color-key fields. Readers and writers keep those representations compatible.
 */
import type { BackgroundRemoval, Visual } from '../types';
import { clamp } from './util';

/** Stable starting values for projects that do not contain background-removal settings. */
export const DEFAULT_BACKGROUND_REMOVAL: BackgroundRemoval = {
  mode: 'off',
  color: '#00ff00',
  similarity: 0.4,
  smoothness: 0.08,
  feather: 0.12,
};

type BackgroundTarget = Pick<Visual, 'chroma' | 'backgroundRemoval'>;

/** Recognizes finite numeric fields accepted by the runtime (normalization clamps their range). */
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Recognizes only canonical, six-digit CSS hex colors before values enter the renderer. */
const isColor = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

/**
 * Type guard for persisted or untrusted background-removal data.
 *
 * This checks shape and finite values but deliberately leaves range clamping to
 * {@link normalizeBackgroundRemoval}.
 */
export function isBackgroundRemoval(value: unknown): value is BackgroundRemoval {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    (v.mode === 'off' || v.mode === 'color' || v.mode === 'subject') &&
    isColor(v.color) &&
    isNumber(v.similarity) &&
    isNumber(v.smoothness) &&
    isNumber(v.feather)
  );
}

/**
 * Produces a renderer-safe copy of background-removal settings.
 *
 * Invalid objects reset to independent defaults. Valid values are cloned, colors are canonicalized
 * to lowercase, and thresholds are clamped to ranges supported by the rendering pipeline.
 */
export function normalizeBackgroundRemoval(value: unknown): BackgroundRemoval {
  if (!isBackgroundRemoval(value)) return { ...DEFAULT_BACKGROUND_REMOVAL };
  return {
    mode: value.mode,
    color: value.color.toLowerCase(),
    similarity: clamp(value.similarity, 0.05, 1),
    smoothness: clamp(value.smoothness, 0, 0.4),
    feather: clamp(value.feather, 0.01, 0.49),
  };
}

/**
 * Reads current settings, including the color-key-only format used by old projects.
 *
 * A modern `backgroundRemoval` value takes precedence. Otherwise the legacy `chroma` fields are
 * migrated in memory without mutating the project.
 */
export function readBackgroundRemoval(item: BackgroundTarget): BackgroundRemoval {
  if (item.backgroundRemoval) return normalizeBackgroundRemoval(item.backgroundRemoval);
  const legacy = item.chroma;
  return {
    ...DEFAULT_BACKGROUND_REMOVAL,
    mode: legacy.enabled ? 'color' : 'off',
    color: isColor(legacy.color) ? legacy.color : DEFAULT_BACKGROUND_REMOVAL.color,
    similarity: clamp(legacy.similarity, 0.05, 1),
    smoothness: clamp(legacy.smoothness, 0, 0.4),
  };
}

/**
 * Applies a normalized patch and keeps both persisted formats synchronized.
 *
 * The modern value is authoritative, while `chroma` mirrors only the color-key parts so older
 * readers continue to understand color mode.
 */
export function writeBackgroundRemoval(target: BackgroundTarget, patch: Partial<BackgroundRemoval>) {
  const next = normalizeBackgroundRemoval({ ...readBackgroundRemoval(target), ...patch });
  target.backgroundRemoval = next;
  target.chroma = {
    enabled: next.mode === 'color',
    color: next.color,
    similarity: next.similarity,
    smoothness: next.smoothness,
  };
}

/** Returns true only when a typed setting enables a non-off background-removal mode. */
export function hasBackgroundRemoval(value: BackgroundRemoval | undefined): value is BackgroundRemoval {
  return !!value && value.mode !== 'off';
}
