import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newProject } from '../lib/defaults';
import { AudioPlayback } from './audio';

class FakeNode {
  starts = 0;
  stops = 0;
  onended: (() => void) | null = null;
  connect() {}
  start() {
    this.starts++;
  }
  stop() {
    this.stops++;
  }
}

let nodes: FakeNode[] = [];
let decodes: ((buf: unknown) => void)[] = [];

class FakeContext {
  state = 'running';
  currentTime = 0;
  sampleRate = 48000;
  destination = {};
  createGain = () => ({ gain: { value: 1 }, connect() {} });
  createBuffer = () => ({});
  createBufferSource = () => nodes[nodes.push(new FakeNode()) - 1];
  decodeAudioData = () => new Promise((done) => decodes.push(done));
  resume = () => Promise.resolve();
  close = () => Promise.resolve();
}

const clip = { arrayBuffer: async () => new ArrayBuffer(8) } as Blob;
const flush = () => new Promise((r) => setTimeout(r, 0));

/** Starts a preview, finishes its decode and returns the node that plays it. */
async function startPreview(pb: AudioPlayback) {
  const p = pb.preview(clip);
  await flush();
  decodes.shift()!({});
  await p;
  return nodes[nodes.length - 1];
}

describe('AudioPlayback preview', () => {
  let pb: AudioPlayback;
  beforeEach(() => {
    nodes = [];
    decodes = [];
    vi.stubGlobal('window', { AudioContext: FakeContext });
    vi.stubGlobal('navigator', {});
    pb = new AudioPlayback(() => newProject('test'));
  });
  afterEach(() => {
    pb.dispose();
    vi.unstubAllGlobals();
  });

  it('replaces the preview that is playing', async () => {
    const a = await startPreview(pb);
    const b = await startPreview(pb);
    expect([a.starts, a.stops, b.starts, b.stops]).toEqual([1, 1, 1, 0]);
    // The replaced node reports its end late; that must not forget the newer preview.
    a.onended?.();
    pb.stopPreview();
    pb.stopPreview();
    expect(b.stops).toBe(1);
  });

  it('cancels a preview that is still decoding, without an error', async () => {
    const p = pb.preview(clip);
    await flush();
    pb.stopPreview();
    decodes[0]({});
    await expect(p).resolves.toBeUndefined();
    expect(nodes).toHaveLength(0);
  });

  it('only reports a failed load when nothing replaced the preview', async () => {
    await expect(pb.preview(Promise.reject(new Error('missing')))).rejects.toThrow('missing');
    const replaced = pb.preview(Promise.reject(new Error('missing')));
    pb.stopPreview();
    await expect(replaced).resolves.toBeUndefined();
  });

  it('is silenced when the timeline plays or stops', async () => {
    const a = await startPreview(pb);
    pb.start(0);
    expect(a.stops).toBe(1);
    const b = await startPreview(pb);
    pb.stop();
    expect(b.stops).toBe(1);
  });
});
