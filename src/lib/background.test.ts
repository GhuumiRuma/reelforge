import { describe, expect, it } from 'vitest';
import type { Visual } from '../types';
import {
  DEFAULT_BACKGROUND_REMOVAL,
  hasBackgroundRemoval,
  normalizeBackgroundRemoval,
  readBackgroundRemoval,
  writeBackgroundRemoval,
} from './background';

const target = (removal?: Visual['backgroundRemoval']): Pick<Visual, 'chroma' | 'backgroundRemoval'> => ({
  backgroundRemoval: removal,
  chroma: { enabled: true, color: '#0000ff', similarity: 0.28, smoothness: 0.14 },
});

describe('background removal settings', () => {
  it('reads old color-key settings without changing their values', () => {
    expect(readBackgroundRemoval(target())).toEqual({
      ...DEFAULT_BACKGROUND_REMOVAL,
      mode: 'color',
      color: '#0000ff',
      similarity: 0.28,
      smoothness: 0.14,
    });
  });

  it('keeps the legacy color-key fields in sync', () => {
    const item = target();
    writeBackgroundRemoval(item, { mode: 'subject', feather: 0.2 });
    expect(item.backgroundRemoval).toMatchObject({ mode: 'subject', feather: 0.2 });
    expect(item.chroma.enabled).toBe(false);

    writeBackgroundRemoval(item, { mode: 'color', color: '#00b140' });
    expect(item.chroma).toMatchObject({ enabled: true, color: '#00b140' });
  });

  it('clamps damaged persisted values into safe ranges', () => {
    expect(normalizeBackgroundRemoval({ mode: 'subject', color: '#FF00AA', similarity: 9, smoothness: -1, feather: 3 })).toEqual({
      mode: 'subject',
      color: '#ff00aa',
      similarity: 1,
      smoothness: 0,
      feather: 0.49,
    });
    expect(normalizeBackgroundRemoval({ mode: 'unknown' })).toEqual(DEFAULT_BACKGROUND_REMOVAL);
  });

  it('treats only active modes as an effect', () => {
    expect(hasBackgroundRemoval(undefined)).toBe(false);
    expect(hasBackgroundRemoval({ ...DEFAULT_BACKGROUND_REMOVAL })).toBe(false);
    expect(hasBackgroundRemoval({ ...DEFAULT_BACKGROUND_REMOVAL, mode: 'subject' })).toBe(true);
  });
});
