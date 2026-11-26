import type { BackgroundRemoval, Visual } from '../types';
import { clamp } from './util';

export const DEFAULT_BACKGROUND_REMOVAL: BackgroundRemoval = {
  mode: 'off',
  color: '#00ff00',
  similarity: 0.4,
  smoothness: 0.08,
  feather: 0.12,
};

type BackgroundTarget = Pick<Visual, 'chroma' | 'backgroundRemoval'>;

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isColor = (v: unknown): v is string => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);

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

/** Reads current settings, including the color-key-only format used by old projects. */
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

/** Writes the new value and keeps legacy readers on color-key settings in sync. */
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

export function hasBackgroundRemoval(value: BackgroundRemoval | undefined): value is BackgroundRemoval {
  return !!value && value.mode !== 'off';
}
