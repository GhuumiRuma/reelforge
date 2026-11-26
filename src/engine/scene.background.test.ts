import { describe, expect, it } from 'vitest';
import type { MediaAsset } from '../types';
import { newProject, videoItem } from '../lib/defaults';
import { writeBackgroundRemoval } from '../lib/background';
import { buildFrame, TextCache, type FrameProvider } from './scene';

const asset: MediaAsset = {
  id: 'm1',
  name: 'person.mp4',
  kind: 'video',
  mime: 'video/mp4',
  size: 1,
  duration: 5,
  width: 1080,
  height: 1920,
  hasAudio: false,
  canDecodeVideo: true,
  canDecodeAudio: false,
  createdAt: 1,
};

const source = { width: 10, height: 10 } as TexImageSource;

describe('scene background removal', () => {
  it('turns a color-key mode into a compositor chroma layer', () => {
    const project = newProject('Color');
    const item = videoItem(asset);
    writeBackgroundRemoval(item, { mode: 'color', color: '#00b140', similarity: 0.5 });
    project.main.push(item);
    const provider: FrameProvider = {
      video: () => ({ source, version: 1 }),
      image: () => null,
    };

    const { spec } = buildFrame(project, 0, {
      W: 1080,
      H: 1920,
      asset: () => asset,
      provider,
      texts: new TextCache(),
      seed: 0,
    });
    const layer = spec.pages[0].layers[0];
    expect(layer.chroma).toMatchObject({ similarity: 0.5 });
    expect(layer.cutout).toBeNull();
  });

  it('passes an automatic matte through without baking it into the source', () => {
    const project = newProject('Subject');
    const item = videoItem(asset);
    writeBackgroundRemoval(item, { mode: 'subject', feather: 0.22 });
    project.main.push(item);
    const provider: FrameProvider = {
      video: () => ({ source, version: 2, matte: { source, version: 'matte-2' } }),
      image: () => null,
    };

    const { spec } = buildFrame(project, 0, {
      W: 1080,
      H: 1920,
      asset: () => asset,
      provider,
      texts: new TextCache(),
      seed: 0,
    });
    expect(spec.pages[0].layers[0].cutout).toMatchObject({ feather: 0.22 });
    expect(spec.pages[0].layers[0].cutout?.matte?.version).toBe('matte-2');
  });
});
