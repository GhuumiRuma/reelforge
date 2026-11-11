import { describe, expect, it } from 'vitest';
import { serializeLook } from '../state/appearance';
import { LOOK_KEY, THEME_KEY } from '../state/theme';
import type { ClipFolder, ClipMeta, MediaAsset, Project } from '../types';
import {
  BACKUP_EXTENSION,
  BackupError,
  BlobSink,
  SETTING_KEYS,
  backupFileName,
  estimateBackup,
  openBackup,
  restoreBackup,
  writeBackup,
  type BackupProblem,
  type BackupStore,
} from './backup';
import type { ClipRecord } from './db';
import { audioItem, imageItem, newProject, textItem, videoItem } from './defaults';

class FakeStore implements BackupStore {
  settings = new Map<string, string>();
  projects = new Map<string, Project>();
  folders = new Map<string, ClipFolder>();
  media = new Map<string, { asset: MediaAsset; blob: Blob }>();
  clips = new Map<string, ClipRecord>();

  async getSetting(key: string) {
    return this.settings.get(key) ?? null;
  }
  async setSetting(key: string, value: string) {
    this.settings.set(key, value);
  }
  async listProjects() {
    return [...this.projects.values()].map((p) => structuredClone(p));
  }
  async getProject(id: string) {
    const p = this.projects.get(id);
    return p && structuredClone(p);
  }
  async saveProject(p: Project) {
    this.projects.set(p.id, structuredClone(p));
  }
  async listFolders() {
    return [...this.folders.values()];
  }
  async putFolder(f: ClipFolder) {
    this.folders.set(f.id, f);
  }
  async hasMedia(id: string) {
    return this.media.has(id);
  }
  async getMedia(id: string) {
    return this.media.get(id);
  }
  async putMedia(asset: MediaAsset, blob: Blob) {
    this.media.set(asset.id, { asset, blob });
  }
  async clipIds() {
    return [...this.clips.keys()];
  }
  async getClip(id: string) {
    return this.clips.get(id);
  }
  async putClip(rec: ClipRecord) {
    this.clips.set(rec.meta.id, rec);
  }
}

const asset = (id: string, kind: MediaAsset['kind'] = 'video'): MediaAsset => ({
  id,
  name: `${id}.${kind === 'video' ? 'mp4' : kind === 'image' ? 'jpg' : 'mp3'}`,
  kind,
  mime: kind === 'video' ? 'video/mp4' : kind === 'image' ? 'image/jpeg' : 'audio/mpeg',
  size: 100,
  duration: kind === 'image' ? 0 : 5,
  width: kind === 'audio' ? 0 : 1080,
  height: kind === 'audio' ? 0 : 1920,
  hasAudio: kind !== 'image',
  canDecodeVideo: true,
  canDecodeAudio: true,
  createdAt: 1,
});

const blobOf = (size: number, seed: number, type: string) => new Blob([new Uint8Array(size).fill(seed)], { type });
const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());
const textOf = async (b: Blob) => new TextDecoder().decode(await b.arrayBuffer());

const clipMeta = (id: string, folderId: string | null, kind: ClipMeta['kind'] = 'video'): ClipMeta => ({
  id,
  name: `Clip ${id}`,
  kind,
  mime: kind === 'video' ? 'video/mp4' : 'audio/mpeg',
  fileName: `${id}.${kind === 'video' ? 'mp4' : 'mp3'}`,
  size: 50,
  duration: 8,
  width: kind === 'video' ? 720 : 0,
  height: kind === 'video' ? 1280 : 0,
  folderId,
  source: 'a link',
  start: 0,
  end: 8,
  createdAt: 3,
});

function project(id: string, name: string, updatedAt: number, items: (p: Project) => void): Project {
  const p = newProject(name);
  p.id = id;
  p.createdAt = 10;
  p.updatedAt = updatedAt;
  items(p);
  return p;
}

/** Two projects sharing one video, one unused file, a folder, two clips and some settings. */
function seeded(): FakeStore {
  const s = new FakeStore();
  const m1 = asset('m1');
  const m2 = asset('m2', 'image');
  const m3 = asset('m3', 'audio');
  const m9 = asset('m9');
  s.media.set('m1', { asset: m1, blob: blobOf(300, 1, 'video/mp4') });
  s.media.set('m2', { asset: m2, blob: blobOf(120, 2, 'image/jpeg') });
  s.media.set('m3', { asset: m3, blob: blobOf(80, 3, 'audio/mpeg') });
  s.media.set('m9', { asset: m9, blob: blobOf(500, 9, 'video/mp4') });

  const trip = project('p1', 'Trip', 2000, (p) => {
    p.main.push(videoItem(m1), imageItem(m2));
    p.texts.push(textItem('Hello', 0, 2));
    p.audios.push(audioItem(m3, 0, 'music'));
  });
  const short = project('p2', 'Short', 3000, (p) => p.main.push(videoItem(m1)));
  s.projects.set(trip.id, trip);
  s.projects.set(short.id, short);

  s.folders.set('f1', { id: 'f1', name: 'Reaction clips', createdAt: 4 });
  s.clips.set('c1', { meta: clipMeta('c1', 'f1'), blob: blobOf(200, 4, 'video/mp4'), poster: blobOf(30, 5, 'image/jpeg') });
  s.clips.set('c2', { meta: clipMeta('c2', null, 'audio'), blob: blobOf(60, 6, 'audio/mpeg'), poster: null });

  s.settings.set('rf-theme', 'light');
  s.settings.set('rf-export', '{"quality":"high"}');
  return s;
}

/** A look as the app saves it, with the CSS and page colors that go with it. */
const SAVED_LOOK = serializeLook({ style: 'slate', accent: '#00b2ff', corners: 'round' });

async function backUp(store: BackupStore, files = true) {
  const sink = new BlobSink();
  const summary = await writeBackup(store, sink, { files, build: 'test' });
  return { blob: sink.toBlob(), summary };
}

const MAGIC = new TextEncoder().encode('RFBACKUP');
const le32 = (n: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};
const baseIndex = { app: 'reelforge', format: 1, createdAt: 5, build: 't', files: true, settings: {}, folders: [], projects: [], media: [], clips: [] };

/** Builds a backup file by hand, to test files that a real backup would never produce. */
function craft(index: unknown, data: Blob[] = [], format = 1): Blob {
  const json = new TextEncoder().encode(typeof index === 'string' ? index : JSON.stringify(index));
  return new Blob([MAGIC, le32(format), ...data, json, le32(json.byteLength), MAGIC]);
}

async function problemOf(source: Blob): Promise<BackupProblem | 'ok'> {
  try {
    await openBackup(source);
    return 'ok';
  } catch (e) {
    if (e instanceof BackupError) return e.problem;
    throw e;
  }
}

describe('writing a backup', () => {
  it('starts and ends with the marker, so a cut-off file is recognised', async () => {
    const { blob } = await backUp(seeded());
    expect(await textOf(blob.slice(0, 8))).toBe('RFBACKUP');
    expect(await textOf(blob.slice(blob.size - 8))).toBe('RFBACKUP');
  });

  it('copies the files that projects use plus the clip library, and leaves unused files out', async () => {
    const { summary } = await backUp(seeded());
    expect(summary).toMatchObject({ projects: 2, folders: 1, media: 3, clips: 2, missing: 0, files: true });
  });

  it('can leave the videos and photos out', async () => {
    const full = await backUp(seeded());
    const slim = await backUp(seeded(), false);
    expect(slim.summary).toMatchObject({ projects: 2, folders: 1, media: 0, clips: 0, files: false });
    // m1 + m2 + m3, then the two clips and the poster
    const fileBytes = 300 + 120 + 80 + 200 + 30 + 60;
    expect(full.blob.size - slim.blob.size).toBeGreaterThanOrEqual(fileBytes);
    const opened = await openBackup(slim.blob);
    expect(opened.index.files).toBe(false);
    expect(opened.index.media).toEqual([]);
    expect(opened.index.clips).toEqual([]);
  });

  it('counts files a project uses that are no longer on the phone', async () => {
    const s = seeded();
    s.media.delete('m3');
    const { summary } = await backUp(s);
    expect(summary).toMatchObject({ media: 2, missing: 1 });
  });

  it('only backs up the settings it knows about', async () => {
    const s = seeded();
    s.settings.set('rf-install-hint', '1');
    s.settings.set('something-else', 'x');
    const opened = await openBackup((await backUp(s)).blob);
    expect(Object.keys(opened.index.settings).sort()).toEqual(['rf-export', 'rf-theme']);
  });

  it('includes the theme setting', () => {
    expect(SETTING_KEYS).toContain(THEME_KEY);
  });

  it('includes the look setting', () => {
    expect(SETTING_KEYS).toContain(LOOK_KEY);
  });

  it('backs up a saved look exactly as it is stored', async () => {
    const s = seeded();
    s.settings.set(LOOK_KEY, SAVED_LOOK);
    const opened = await openBackup((await backUp(s)).blob);
    expect(opened.index.settings[LOOK_KEY]).toBe(SAVED_LOOK);
  });

  it('reports progress that never goes backwards and ends at 1', async () => {
    const seen: number[] = [];
    const labels = new Set<string>();
    await writeBackup(seeded(), new BlobSink(), {
      files: true,
      onProgress: (p, label) => {
        seen.push(p);
        labels.add(label);
      },
    });
    expect(seen[0]).toBe(0);
    expect(seen.at(-1)).toBe(1);
    seen.forEach((p, i) => i > 0 && expect(p).toBeGreaterThanOrEqual(seen[i - 1]));
    expect(seen.every((p) => p >= 0 && p <= 1)).toBe(true);
    expect(labels.has('Copying videos and photos…')).toBe(true);
    expect(labels.has('Copying clips…')).toBe(true);
  });

  it('stops when cancelled, before and during the copy', async () => {
    const early = new AbortController();
    early.abort();
    await expect(writeBackup(seeded(), new BlobSink(), { files: true, signal: early.signal })).rejects.toMatchObject({ name: 'AbortError' });

    const ctl = new AbortController();
    const sink = new BlobSink();
    let writes = 0;
    const write = sink.write.bind(sink);
    sink.write = async (part, onBytes) => {
      await write(part, onBytes);
      if (++writes === 4) ctl.abort();
    };
    await expect(writeBackup(seeded(), sink, { files: true, signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('names backups by date and time', () => {
    const at = new Date(2026, 6, 4, 9, 5);
    expect(backupFileName(true, at)).toBe('ReelForge-backup-2026-07-04-0905.rfbackup');
    expect(backupFileName(false, at)).toBe('ReelForge-backup-2026-07-04-0905-projects-only.rfbackup');
    expect(BACKUP_EXTENSION).toBe('.rfbackup');
  });
});

describe('estimating a backup', () => {
  it('counts what a backup would hold, and agrees with the backup that is then written', async () => {
    const s = seeded();
    const est = await estimateBackup(s, true);
    const { summary, blob } = await backUp(s);
    expect(est).toEqual({ projects: 2, media: 3, clips: 2, missing: 0, bytes: 300 + 120 + 80 + 200 + 30 + 60 });
    expect(est).toMatchObject({ projects: summary.projects, media: summary.media, clips: summary.clips, missing: summary.missing });
    // the projects and settings come on top of the files
    expect(blob.size).toBeGreaterThan(est.bytes);
  });

  it('counts no files when they are left out', async () => {
    expect(await estimateBackup(seeded(), false)).toEqual({ projects: 2, media: 0, clips: 0, missing: 0, bytes: 0 });
  });

  it('counts files a project uses that are gone, and writes nothing', async () => {
    const s = seeded();
    s.media.delete('m3');
    expect(await estimateBackup(s, true)).toMatchObject({ media: 2, missing: 1 });
    expect(await estimateBackup(new FakeStore(), true)).toEqual({ projects: 0, media: 0, clips: 0, missing: 0, bytes: 0 });
  });

  it('stops when cancelled', async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(estimateBackup(seeded(), true, ctl.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('restoring a backup', () => {
  it('brings back projects, files, clips, folders and settings on an empty phone', async () => {
    const src = seeded();
    const opened = await openBackup((await backUp(src)).blob);
    expect(opened.dropped).toBe(0);

    const dst = new FakeStore();
    const sum = await restoreBackup(opened, dst);

    expect(sum).toMatchObject({
      projects: { added: 2, updated: 0, kept: 0 },
      media: { added: 3, kept: 0 },
      clips: { added: 2, kept: 0 },
      folders: 1,
      settings: 2,
      incomplete: 0,
      dropped: 0,
    });
    expect(dst.projects.get('p1')).toEqual(src.projects.get('p1'));
    expect(dst.projects.get('p2')).toEqual(src.projects.get('p2'));
    expect(dst.folders.get('f1')).toEqual(src.folders.get('f1'));
    expect(dst.settings.get('rf-theme')).toBe('light');
    expect(dst.settings.get('rf-export')).toBe('{"quality":"high"}');

    expect([...dst.media.keys()].sort()).toEqual(['m1', 'm2', 'm3']);
    for (const id of ['m1', 'm2', 'm3']) {
      const got = dst.media.get(id)!;
      const want = src.media.get(id)!;
      expect(got.asset).toEqual(want.asset);
      expect(got.blob.type).toBe(want.blob.type);
      expect(await bytesOf(got.blob)).toEqual(await bytesOf(want.blob));
    }

    const c1 = dst.clips.get('c1')!;
    const w1 = src.clips.get('c1')!;
    expect(c1.meta).toEqual(w1.meta);
    expect(await bytesOf(c1.blob)).toEqual(await bytesOf(w1.blob));
    expect(await bytesOf(c1.poster!)).toEqual(await bytesOf(w1.poster!));
    expect(c1.poster!.type).toBe('image/jpeg');
    expect(dst.clips.get('c2')!.poster).toBeNull();
  });

  it('restores projects without their files from a projects-only backup and says so', async () => {
    const opened = await openBackup((await backUp(seeded(), false)).blob);
    const dst = new FakeStore();
    const sum = await restoreBackup(opened, dst);
    expect(sum.projects.added).toBe(2);
    expect(sum.incomplete).toBe(2);
    expect(dst.media.size).toBe(0);
    expect(dst.clips.size).toBe(0);
    expect(dst.folders.size).toBe(1);
  });

  it('does not count a project as incomplete when its files are already on the phone', async () => {
    const src = seeded();
    const opened = await openBackup((await backUp(src, false)).blob);
    const dst = new FakeStore();
    for (const [id, rec] of src.media) dst.media.set(id, rec);
    const sum = await restoreBackup(opened, dst);
    expect(sum.projects.added).toBe(2);
    expect(sum.incomplete).toBe(0);
  });

  it('can be run again without changing anything or duplicating anything', async () => {
    const opened = await openBackup((await backUp(seeded())).blob);
    const dst = new FakeStore();
    await restoreBackup(opened, dst);
    const again = await restoreBackup(opened, dst);
    expect(again).toMatchObject({
      projects: { added: 0, updated: 0, kept: 2 },
      media: { added: 0, kept: 3 },
      clips: { added: 0, kept: 2 },
      folders: 0,
      settings: 0,
    });
    expect(dst.projects.size).toBe(2);
    expect(dst.media.size).toBe(3);
    expect(dst.clips.size).toBe(2);
  });

  it('leaves what is already on the phone alone', async () => {
    const src = seeded();
    const opened = await openBackup((await backUp(src)).blob);

    const dst = new FakeStore();
    const mine = blobOf(10, 7, 'video/mp4');
    dst.media.set('m1', { asset: asset('m1'), blob: mine });
    dst.folders.set('f1', { id: 'f1', name: 'Renamed here', createdAt: 99 });
    dst.clips.set('c1', { meta: { ...clipMeta('c1', null), name: 'Edited here' }, blob: blobOf(5, 8, 'video/mp4'), poster: null });
    dst.settings.set('rf-theme', 'dark');

    const sum = await restoreBackup(opened, dst);

    expect(dst.media.get('m1')!.blob).toBe(mine);
    expect(dst.folders.get('f1')!.name).toBe('Renamed here');
    expect(dst.clips.get('c1')!.meta.name).toBe('Edited here');
    expect(dst.settings.get('rf-theme')).toBe('dark');
    expect(sum.media).toEqual({ added: 2, kept: 1 });
    expect(sum.clips).toEqual({ added: 1, kept: 1 });
    expect(sum.folders).toBe(0);
    expect(sum.settings).toBe(1);
  });

  it('brings back a saved look exactly, and counts it with the other settings', async () => {
    const src = seeded();
    src.settings.set(LOOK_KEY, SAVED_LOOK);
    const opened = await openBackup((await backUp(src)).blob);

    const dst = new FakeStore();
    const sum = await restoreBackup(opened, dst);

    expect(dst.settings.get(LOOK_KEY)).toBe(SAVED_LOOK);
    expect(sum.settings).toBe(3);
  });

  it('leaves a look that is already on the phone alone', async () => {
    const src = seeded();
    src.settings.set(LOOK_KEY, SAVED_LOOK);
    const opened = await openBackup((await backUp(src)).blob);
    expect(opened.index.settings[LOOK_KEY]).toBe(SAVED_LOOK);

    const dst = new FakeStore();
    const mine = serializeLook({ style: 'warm', accent: '#33c98a', corners: 'sharp' });
    dst.settings.set(LOOK_KEY, mine);
    const sum = await restoreBackup(opened, dst);

    expect(dst.settings.get(LOOK_KEY)).toBe(mine);
    // the mode and the export options still come over
    expect(sum.settings).toBe(2);
  });

  it('restores a backup made before looks were saved without adding one', async () => {
    const opened = await openBackup(craft({ ...baseIndex, settings: { 'rf-theme': 'light' } }));
    const dst = new FakeStore();
    const sum = await restoreBackup(opened, dst);
    expect(sum.settings).toBe(1);
    expect(dst.settings.has(LOOK_KEY)).toBe(false);
  });

  it('keeps a project that is newer on the phone, and replaces one that is older', async () => {
    const src = seeded();
    const opened = await openBackup((await backUp(src)).blob);

    const dst = new FakeStore();
    for (const [id, rec] of src.media) dst.media.set(id, rec);
    const p1 = structuredClone(src.projects.get('p1')!);
    p1.name = 'Edited on the phone';
    p1.updatedAt = 9000;
    const p2 = structuredClone(src.projects.get('p2')!);
    p2.name = 'Old copy';
    p2.updatedAt = 1;
    dst.projects.set('p1', p1);
    dst.projects.set('p2', p2);

    const sum = await restoreBackup(opened, dst);

    expect(dst.projects.get('p1')!.name).toBe('Edited on the phone');
    expect(dst.projects.get('p2')!.name).toBe('Short');
    expect(sum.projects).toEqual({ added: 0, updated: 1, kept: 1 });
  });

  it('does not swap in a newer project that would lose its files', async () => {
    const src = seeded();
    const opened = await openBackup((await backUp(src, false)).blob);

    const dst = new FakeStore();
    const old = structuredClone(src.projects.get('p2')!);
    old.name = 'Old copy';
    old.updatedAt = 1;
    dst.projects.set('p2', old);

    const sum = await restoreBackup(opened, dst);
    expect(dst.projects.get('p2')!.name).toBe('Old copy');
    expect(sum.projects).toEqual({ added: 1, updated: 0, kept: 1 });
  });

  it('files a clip at the top level when its folder is gone', async () => {
    const index = {
      ...baseIndex,
      clips: [{ meta: clipMeta('c1', 'gone'), file: { offset: 12, size: 5, type: 'video/mp4' }, poster: null }],
    };
    const opened = await openBackup(craft(index, [new Blob(['hello'])]));
    const dst = new FakeStore();
    await restoreBackup(opened, dst);
    expect(dst.clips.get('c1')!.meta.folderId).toBeNull();
    expect(await textOf(dst.clips.get('c1')!.blob)).toBe('hello');
  });

  it('reports progress that never goes backwards and ends at 1', async () => {
    const opened = await openBackup((await backUp(seeded())).blob);
    const seen: number[] = [];
    await restoreBackup(opened, new FakeStore(), { onProgress: (p) => seen.push(p) });
    expect(seen[0]).toBe(0);
    expect(seen.at(-1)).toBe(1);
    seen.forEach((p, i) => i > 0 && expect(p).toBeGreaterThanOrEqual(seen[i - 1]));
  });

  it('stops when cancelled and can be picked up again', async () => {
    const opened = await openBackup((await backUp(seeded())).blob);
    const dst = new FakeStore();
    const ctl = new AbortController();
    const put = dst.putMedia.bind(dst);
    dst.putMedia = async (a, b) => {
      await put(a, b);
      ctl.abort();
    };
    await expect(restoreBackup(opened, dst, { signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' });
    // Projects come last, so nothing was left pointing at files that never arrived.
    expect(dst.projects.size).toBe(0);
    expect(dst.media.size).toBe(1);

    const sum = await restoreBackup(opened, dst);
    expect(sum.media).toEqual({ added: 2, kept: 1 });
    expect(dst.projects.size).toBe(2);
    expect(dst.media.size).toBe(3);
  });
});

describe('opening a file that is not a usable backup', () => {
  it('rejects other files', async () => {
    expect(await problemOf(new Blob(['this is just a text file, not a ReelForge backup at all']))).toBe('not-backup');
    expect(await problemOf(new Blob([]))).toBe('not-backup');
    expect(await problemOf(blobOf(4096, 0, 'video/mp4'))).toBe('not-backup');
  });

  it('rejects a backup that stopped part-way', async () => {
    const { blob } = await backUp(seeded());
    expect(await problemOf(blob.slice(0, blob.size - 5))).toBe('incomplete');
    expect(await problemOf(blob.slice(0, Math.floor(blob.size / 2)))).toBe('incomplete');
    expect(await problemOf(new Blob([MAGIC, le32(1), new Uint8Array(200)]))).toBe('incomplete');
  });

  it('asks for an update when the backup comes from a newer app', async () => {
    const { blob } = await backUp(seeded());
    const newer = new Blob([blob.slice(0, 8), le32(2), blob.slice(12)]);
    expect(await problemOf(newer)).toBe('newer');
  });

  it('rejects an index that cannot be right', async () => {
    const { blob } = await backUp(seeded());
    expect(await problemOf(new Blob([blob.slice(0, blob.size - 12), le32(0), MAGIC]))).toBe('damaged');
    expect(await problemOf(new Blob([blob.slice(0, blob.size - 12), le32(0xffffffff), MAGIC]))).toBe('damaged');
    expect(await problemOf(new Blob([blob.slice(0, blob.size - 12), le32(blob.size), MAGIC]))).toBe('damaged');
    expect(await problemOf(craft('{ not json'))).toBe('damaged');
    expect(await problemOf(craft([]))).toBe('damaged');
    expect(await problemOf(craft({ ...baseIndex, app: 'other' }))).toBe('damaged');
    expect(await problemOf(craft({ ...baseIndex, files: 'yes' }))).toBe('damaged');
  });

  it('accepts an empty backup', async () => {
    const opened = await openBackup(craft(baseIndex));
    expect(opened.dropped).toBe(0);
    expect(opened.index.projects).toEqual([]);
  });

  it('skips entries that are damaged and counts them', async () => {
    const good = asset('ok');
    const data = new Blob(['0123456789']);
    const index = {
      ...baseIndex,
      media: [
        { asset: good, file: { offset: 12, size: 10, type: 'video/mp4' } },
        // runs past the end of the file data
        { asset: asset('long'), file: { offset: 12, size: 11, type: 'video/mp4' } },
        // points into the header
        { asset: asset('head'), file: { offset: 0, size: 5, type: 'video/mp4' } },
        { asset: asset('frac'), file: { offset: 12.5, size: 2, type: 'video/mp4' } },
        { asset: asset('neg'), file: { offset: 12, size: -1, type: 'video/mp4' } },
        { asset: { id: 'x' }, file: { offset: 12, size: 1, type: 'video/mp4' } },
        { asset: asset('nofile') },
        'junk',
      ],
      folders: [{ id: 'f', name: 'ok', createdAt: 1 }, { id: '', name: 'no id', createdAt: 1 }, 7],
    };
    const opened = await openBackup(craft(index, [data]));
    expect(opened.index.media.map((m) => m.asset.id)).toEqual(['ok']);
    expect(opened.index.folders.map((f) => f.id)).toEqual(['f']);
    expect(opened.dropped).toBe(7 + 2);
  });

  it('skips projects that the app could not open', async () => {
    const ok = project('ok', 'Fine', 5, (p) => p.main.push(videoItem(asset('m1'))));
    const wrongAspect = { ...structuredClone(ok), id: 'a', aspect: '99:1' };
    const wrongVersion = { ...structuredClone(ok), id: 'v', version: 2 };
    const noTrack = (() => {
      const p: Record<string, unknown> = { ...structuredClone(ok), id: 't' };
      delete p.audios;
      return p;
    })();
    const badItem = { ...structuredClone(ok), id: 'i', main: [{ id: 'x', type: 'video', start: 0, duration: 1 }] };
    const unknownItem = { ...structuredClone(ok), id: 'u', main: [{ id: 'x', type: 'hologram', start: 0, duration: 1 }] };
    const opened = await openBackup(craft({ ...baseIndex, projects: [ok, wrongAspect, wrongVersion, noTrack, badItem, unknownItem, null] }));
    expect(opened.index.projects.map((p) => p.id)).toEqual(['ok']);
    expect(opened.dropped).toBe(6);
  });

  it('only accepts known settings with text values', async () => {
    const settings = { 'rf-theme': 'light', 'rf-export': 42, 'rf-install-hint': '1', evil: 'x', __proto__: 'y' };
    const opened = await openBackup(craft(`{"app":"reelforge","format":1,"createdAt":5,"files":true,"settings":${JSON.stringify(settings)}}`));
    expect(opened.index.settings).toEqual({ 'rf-theme': 'light' });
    expect(opened.index.projects).toEqual([]);
  });

  it('drops a look that is not text', async () => {
    const looks = [{ v: 1, style: 'slate', accent: '#00b2ff', corners: 'round' }, 42, null, ['slate']];
    for (const look of looks) {
      const opened = await openBackup(craft({ ...baseIndex, settings: { 'rf-theme': 'light', [LOOK_KEY]: look } }));
      expect(opened.index.settings).toEqual({ 'rf-theme': 'light' });
    }
  });
});
