import { describe, expect, it, vi } from 'vitest';
import {
  LAST_BACKUP_KEY,
  LAST_BUILD_KEY,
  RECENT_BACKUP_MS,
  checkReminder,
  markBackedUp,
  readLastBackup,
  shouldRemind,
  type ReminderEnv,
  type ReminderInput,
} from './backupReminder';

const NOW = Date.parse('2026-07-14T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const input = (over: Partial<ReminderInput> = {}): ReminderInput => ({
  native: true,
  previousBuild: 'aaa',
  currentBuild: 'bbb',
  lastBackupAt: null,
  hasData: true,
  now: NOW,
  ...over,
});

describe('shouldRemind', () => {
  it('asks after an update when there is something to lose and no backup', () => {
    expect(shouldRemind(input())).toBe(true);
  });

  it('asks on the first launch of a build that can note its version, if work is already on the phone', () => {
    expect(shouldRemind(input({ previousBuild: null }))).toBe(true);
  });

  it('does not ask on a fresh install, or when there is nothing to back up', () => {
    expect(shouldRemind(input({ previousBuild: null, hasData: false }))).toBe(false);
    expect(shouldRemind(input({ hasData: false }))).toBe(false);
  });

  it('does not ask when the build has not changed', () => {
    expect(shouldRemind(input({ previousBuild: 'bbb' }))).toBe(false);
  });

  it('does not ask in a browser, where updates leave the data alone', () => {
    expect(shouldRemind(input({ native: false }))).toBe(false);
  });

  it('does not ask when a backup is recent, and asks when the last one is more than a week old', () => {
    expect(shouldRemind(input({ lastBackupAt: NOW - DAY }))).toBe(false);
    expect(shouldRemind(input({ lastBackupAt: NOW - RECENT_BACKUP_MS }))).toBe(false);
    expect(shouldRemind(input({ lastBackupAt: NOW - RECENT_BACKUP_MS - 1 }))).toBe(true);
    expect(shouldRemind(input({ lastBackupAt: NOW - 30 * DAY }))).toBe(true);
  });

  it('treats a backup dated in the future (the clock was changed) as recent', () => {
    expect(shouldRemind(input({ lastBackupAt: NOW + 3 * DAY }))).toBe(false);
  });
});

function fakeEnv(over: Partial<ReminderEnv> = {}, store: Record<string, string> = {}) {
  const env: ReminderEnv = {
    native: true,
    build: 'bbb',
    now: NOW,
    read: (k) => store[k] ?? null,
    write: (k, v) => {
      store[k] = v;
    },
    hasData: vi.fn(async () => true),
    ...over,
  };
  return { env, store };
}

describe('checkReminder', () => {
  it('asks after an update, and notes the new build', async () => {
    const { env, store } = fakeEnv({}, { [LAST_BUILD_KEY]: 'aaa' });
    expect(await checkReminder(env)).toBe(true);
    expect(store[LAST_BUILD_KEY]).toBe('bbb');
  });

  it('asks once: the next launch of the same build does not', async () => {
    const { env, store } = fakeEnv({}, { [LAST_BUILD_KEY]: 'aaa' });
    expect(await checkReminder(env)).toBe(true);
    expect(await checkReminder({ ...env, read: (k) => store[k] ?? null })).toBe(false);
  });

  it('does not read the saved work when the build is unchanged', async () => {
    const { env } = fakeEnv({}, { [LAST_BUILD_KEY]: 'bbb' });
    expect(await checkReminder(env)).toBe(false);
    expect(env.hasData).not.toHaveBeenCalled();
  });

  it('notes the build on a fresh install without asking', async () => {
    const { env, store } = fakeEnv({ hasData: vi.fn(async () => false) });
    expect(await checkReminder(env)).toBe(false);
    expect(store[LAST_BUILD_KEY]).toBe('bbb');
  });

  it('asks when work from an older version is on the phone and no build was noted', async () => {
    const { env } = fakeEnv();
    expect(await checkReminder(env)).toBe(true);
  });

  it('does not ask again right after a backup was made', async () => {
    const { env } = fakeEnv({}, { [LAST_BUILD_KEY]: 'aaa', [LAST_BACKUP_KEY]: String(NOW - 60_000) });
    expect(await checkReminder(env)).toBe(false);
  });

  it('does nothing in a browser', async () => {
    const { env, store } = fakeEnv({ native: false }, { [LAST_BUILD_KEY]: 'aaa' });
    expect(await checkReminder(env)).toBe(false);
    expect(store[LAST_BUILD_KEY]).toBe('aaa');
    expect(env.hasData).not.toHaveBeenCalled();
  });

  it('notes the build even when the saved work cannot be read, and lets the error through', async () => {
    const { env, store } = fakeEnv({ hasData: vi.fn(async () => Promise.reject(new Error('no storage'))) }, { [LAST_BUILD_KEY]: 'aaa' });
    await expect(checkReminder(env)).rejects.toThrow('no storage');
    expect(store[LAST_BUILD_KEY]).toBe('bbb');
  });
});

describe('the last backup', () => {
  it('reads what markBackedUp wrote', () => {
    const { env, store } = fakeEnv();
    expect(readLastBackup(env)).toBeNull();
    markBackedUp(env);
    expect(store[LAST_BACKUP_KEY]).toBe(String(NOW));
    expect(readLastBackup(env)).toBe(NOW);
  });

  it.each(['', '0', '-5', 'yesterday', 'NaN', 'Infinity'])('ignores a stored value of %j', (v) => {
    const { env } = fakeEnv({}, { [LAST_BACKUP_KEY]: v });
    expect(readLastBackup(env)).toBeNull();
  });
});
