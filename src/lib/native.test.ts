import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nativeShare } from './native';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// The plugins only exist on a phone. These stand in for them and note what was asked, in order.
const fake = vi.hoisted(() => ({
  log: [] as string[],
  files: [] as { name: string; type: 'file' | 'directory'; mtime: number }[],
  listFails: false,
  deleteFails: false,
}));

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE', Documents: 'DOCUMENTS' },
  Filesystem: {
    readdir: async ({ path }: { path: string }) => {
      fake.log.push(`list ${path}`);
      if (fake.listFails) throw new Error('Folder does not exist');
      return { files: fake.files };
    },
    deleteFile: async ({ path }: { path: string }) => {
      fake.log.push(`delete ${path}`);
      if (fake.deleteFails) throw new Error('Could not delete');
    },
    writeFile: async ({ path }: { path: string }) => void fake.log.push(`write ${path}`),
    appendFile: async () => undefined,
    getUri: async ({ path }: { path: string }) => ({ uri: `file:///cache/${path}` }),
  },
}));

vi.mock('@capacitor/share', () => ({
  Share: { share: async ({ files }: { files: string[] }) => void fake.log.push(`share ${files[0]}`) },
}));

describe('sharing a file from the Android app', () => {
  const file = () => new File(['backup'], 'new.rfbackup');
  const newCopy = ['write share/new.rfbackup', 'share file:///cache/share/new.rfbackup'];

  beforeEach(() => {
    fake.log.length = 0;
    fake.files = [];
    fake.listFails = false;
    fake.deleteFails = false;
  });

  it('clears copies from earlier shares that are over a day old before writing the new one', async () => {
    const now = Date.now();
    fake.files = [
      { name: 'old.rfbackup', type: 'file', mtime: now - 2 * DAY },
      { name: 'recent.rfbackup', type: 'file', mtime: now - HOUR },
      { name: 'folder', type: 'directory', mtime: now - 3 * DAY },
    ];
    await expect(nativeShare(file(), 'ReelForge backup')).resolves.toBe('shared');
    expect(fake.log).toEqual(['list share', 'delete share/old.rfbackup', ...newCopy]);
  });

  it('still shares when nothing has been shared before', async () => {
    fake.listFails = true;
    await expect(nativeShare(file(), 'ReelForge backup')).resolves.toBe('shared');
    expect(fake.log).toEqual(['list share', ...newCopy]);
  });

  it('still shares when an old copy cannot be removed', async () => {
    fake.files = [{ name: 'old.rfbackup', type: 'file', mtime: Date.now() - 2 * DAY }];
    fake.deleteFails = true;
    await expect(nativeShare(file(), 'ReelForge backup')).resolves.toBe('shared');
    expect(fake.log).toEqual(['list share', 'delete share/old.rfbackup', ...newCopy]);
  });
});
