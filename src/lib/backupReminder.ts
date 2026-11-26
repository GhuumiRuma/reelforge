/**
 * Offers a backup the first time the Android app opens after it was updated.
 *
 * Android keeps an app's data when a newer build with the same signature is installed over it, so an
 * update normally loses nothing. The reminder is for the times it can go wrong (a different
 * signature, an uninstall, "clear storage") and costs a minute: it asks once per update, only when
 * there is something to lose and no recent backup.
 */
import { BUILD_ID } from './build';
import { listClipIds, listProjects } from './db';
import { isNativeApp } from './util';

/** Local-storage key that remembers the build seen during the previous native launch. */
export const LAST_BUILD_KEY = 'rf-last-build';
/** Local-storage key containing the timestamp of the last successful backup. */
export const LAST_BACKUP_KEY = 'rf-last-backup';
/** A backup this recent is good enough: no need to ask again after an update. */
export const RECENT_BACKUP_MS = 7 * 24 * 60 * 60 * 1000;

/** Pure inputs used to decide whether an app-update backup reminder is appropriate. */
export interface ReminderInput {
  native: boolean;
  /** the build that last ran here, or null if none was noted (a first launch, or a build from before this existed) */
  previousBuild: string | null;
  currentBuild: string;
  lastBackupAt: number | null;
  hasData: boolean;
  now: number;
}

/**
 * Decides whether an update should offer a backup without performing storage I/O.
 *
 * Browser launches and native installs without user data do not qualify, and a backup from the
 * recent window suppresses the prompt. A missing previous build is treated as an older install.
 */
export function shouldRemind(i: ReminderInput): boolean {
  // A phone with nothing on it has nothing to lose; without a noted build, data means an older version ran here.
  if (!i.native || !i.hasData || i.previousBuild === i.currentBuild) return false;
  return i.lastBackupAt === null || i.now - i.lastBackupAt > RECENT_BACKUP_MS;
}

/** Injectable storage and database environment that makes reminder behavior deterministic in tests. */
export interface ReminderEnv {
  /** Whether this launch can use native-app update behavior. */
  native: boolean;
  /** Build identifier that is written as the newly observed launch. */
  build: string;
  /** Injected clock value used for recent-backup and persistence timestamps. */
  now: number;
  /** Reads a preference key, returning `null` when absent or inaccessible. */
  read(key: string): string | null;
  /** Best-effort write of an update-reminder preference. */
  write(key: string, value: string): void;
  /** Resolves true when the local database/library contains anything worth backing up. */
  hasData(): Promise<boolean>;
}

/**
 * Builds the production reminder environment.
 *
 * Local-storage failures become missing values, so blocked preference storage cannot prevent the
 * app from opening. Data presence comes from IndexedDB and counts either projects or saved clips.
 */
const liveEnv = (): ReminderEnv => ({
  native: isNativeApp(),
  build: BUILD_ID,
  now: Date.now(),
  read: (key) => {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  write: (key, value) => {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Blocked storage only means the reminder may come back next launch.
    }
  },
  hasData: async () => (await listProjects()).length > 0 || (await listClipIds()).length > 0,
});

/** When the last backup was made on this phone, or null if there hasn't been one. */
export function readLastBackup(env: Pick<ReminderEnv, 'read'> = liveEnv()): number | null {
  const n = Number(env.read(LAST_BACKUP_KEY));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Records the current time as the most recent successful backup, on a best-effort basis. */
export function markBackedUp(env: Pick<ReminderEnv, 'write' | 'now'> = liveEnv()): void {
  env.write(LAST_BACKUP_KEY, String(env.now));
}

/** Notes this build as the one that ran, and says whether to offer a backup because it's new. */
export async function checkReminder(env: ReminderEnv = liveEnv()): Promise<boolean> {
  if (!env.native) return false;
  const previousBuild = env.read(LAST_BUILD_KEY);
  // Noted right away, so an update asks once however the notice is answered.
  env.write(LAST_BUILD_KEY, env.build);
  if (previousBuild === env.build) return false;
  return shouldRemind({
    native: env.native,
    previousBuild,
    currentBuild: env.build,
    lastBackupAt: readLastBackup(env),
    hasData: await env.hasData(),
    now: env.now,
  });
}

let decided: Promise<boolean> | null = null;

/** The answer for this launch. It is worked out once, so Home mounting again can't ask twice. */
export function reminderForThisLaunch(): Promise<boolean> {
  decided ??= checkReminder().catch(() => false);
  return decided;
}

/** The notice was answered, by dismissing it or by making a backup. */
export function answerReminder(): void {
  decided = Promise.resolve(false);
}
