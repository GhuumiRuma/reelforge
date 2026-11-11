import { ArchiveRestore, DatabaseBackup, FolderOpen, Share } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  BACKUP_EXTENSION,
  BACKUP_MIME,
  BackupError,
  BlobSink,
  backupFileName,
  estimateBackup,
  openBackup,
  restoreBackup,
  writeBackup,
  type BackupEstimate,
  type BackupSummary,
  type OpenedBackup,
  type RestoreSummary,
} from '../lib/backup';
import { markBackedUp, readLastBackup } from '../lib/backupReminder';
import { appStore } from '../lib/backupStore';
import { BUILD_ID } from '../lib/build';
import { acquireWakeLock, pickFiles } from '../lib/device';
import { haptic } from '../lib/haptics';
import { ago, downloadBlob, formatBytes, isNativeApp } from '../lib/util';
import { Progress, Sheet, Toggle } from './common';

type Job = 'backup' | 'check' | 'restore' | 'share';

const BUSY: Record<Job, string> = {
  backup: 'Your backup is still saving — tap Cancel to stop',
  check: 'Still checking the file — tap Cancel to stop',
  restore: 'Your backup is still being restored — tap Cancel to stop',
  share: 'Still getting your backup ready — tap Cancel to stop',
};

/** A backup that was made in this sheet. */
interface Saved {
  summary: BackupSummary;
  blob: Blob;
  name: string;
  /** where it was written on the phone; null for a download, or a backup that was only shared */
  where: string | null;
  shared: boolean;
}

type Retry =
  | { kind: 'backup' }
  | { kind: 'pick' }
  | { kind: 'restore'; opened: OpenedBackup; name: string }
  | { kind: 'share'; saved: Saved };

type View =
  | { kind: 'home' }
  | { kind: 'running'; job: Job; label: string; progress: number | null; stopping: boolean }
  | { kind: 'preview'; opened: OpenedBackup; name: string }
  | { kind: 'saved'; saved: Saved }
  | { kind: 'restored'; opened: OpenedBackup; name: string; summary: RestoreSummary | null }
  | { kind: 'error'; title: string; message: string; retry: Retry | null; shareInstead: Saved | null };

/** What a running job gets: its cancel signal, and a way to report how far it is (null: can't say). */
interface JobContext {
  signal: AbortSignal;
  show(progress: number | null, label?: string): void;
}

const isAbort = (e: unknown) => (e as { name?: string } | null)?.name === 'AbortError';

function describe(e: unknown): string {
  if (e instanceof BackupError) return e.message;
  const msg = e instanceof Error ? e.message : String(e ?? '');
  const name = (e as { name?: string } | null)?.name;
  if (name === 'QuotaExceededError' || /quota|no space|not enough space|ENOSPC|disk full|storage full/i.test(msg)) {
    return 'There isn’t enough free space on this phone. Free some up and try again.';
  }
  if (/reclaim|background|inactiv/i.test(msg)) return 'ReelForge went into the background. Keep it open and try again.';
  return msg || 'Something went wrong.';
}

const when = (t: number) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function titleOf(v: View): string {
  switch (v.kind) {
    case 'running':
      return v.job === 'backup' ? 'Backing up' : v.job === 'share' ? 'Getting ready to share' : v.job === 'check' ? 'Checking the backup' : 'Restoring';
    case 'preview':
      return 'Restore a backup';
    case 'saved':
      return v.saved.where ? 'Backup saved' : v.saved.shared ? 'Backup shared' : 'Backup downloaded';
    case 'restored':
      return v.summary ? 'Restore finished' : 'Restore stopped';
    default:
      return 'Back up and restore';
  }
}

function Rows({ rows }: { rows: [string, string | number][] }) {
  return (
    <div className="stats">
      {rows.map(([label, value]) => (
        <p key={label} className="stat-row">
          <span>{label}</span>
          <span>{value}</span>
        </p>
      ))}
    </div>
  );
}

function backupRows(s: { projects: number; media: number; clips: number }, files: boolean, size: string | null): [string, string | number][] {
  const rows: [string, string | number][] = [['Projects', s.projects]];
  // A backup made without files has none to count.
  if (files) rows.push(['Videos, photos and audio', s.media], ['Clips', s.clips]);
  if (size) rows.push(['Size', size]);
  return rows;
}

function MissingNote({ n }: { n: number }) {
  if (n <= 0) return null;
  return (
    <p className="note">
      {n} {n === 1 ? 'file' : 'files'} your projects use {n === 1 ? 'isn’t' : 'aren’t'} on this phone any more, so {n === 1 ? 'it' : 'they'} can’t be backed up.
    </p>
  );
}

interface Props {
  onClose: () => void;
  /** called whenever a restore may have changed what's on the phone, including a stopped or failed one */
  onRestored: () => void;
  /** called when a backup has been saved or shared */
  onBackedUp: () => void;
}

export function BackupSheet({ onClose, onRestored, onBackedUp }: Props) {
  const native = isNativeApp();
  const [view, setView] = useState<View>({ kind: 'home' });
  const [withFiles, setWithFiles] = useState(true);
  const [estimate, setEstimate] = useState<BackupEstimate | 'unreadable' | null>(null);
  const [lastBackup, setLastBackup] = useState<number | null>(() => readLastBackup());
  // Only one job at a time. It stays set until the job has finished, even after Cancel, so a new one
  // can't start while the old one is still tidying up after itself.
  const ctl = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const pickTaps = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      ctl.current?.abort();
    };
  }, []);

  const atHome = view.kind === 'home';
  useEffect(() => {
    if (!atHome) return;
    const ac = new AbortController();
    setEstimate(null);
    estimateBackup(appStore, withFiles, ac.signal).then(
      (e) => {
        if (!ac.signal.aborted) setEstimate(e);
      },
      (e) => {
        if (ac.signal.aborted) return;
        console.error(e);
        setEstimate('unreadable');
      },
    );
    return () => ac.abort();
  }, [atHome, withFiles]);

  const run = (job: Job, label: string, work: (ctx: JobContext) => Promise<View>) => {
    if (ctl.current) return;
    const ac = new AbortController();
    ctl.current = ac;
    let text = label;
    const show = (progress: number | null, next?: string) => {
      if (next) text = next;
      if (mounted.current) setView({ kind: 'running', job, label: text, progress, stopping: ac.signal.aborted });
    };
    show(null);
    void (async () => {
      const lock = await acquireWakeLock();
      let next: View;
      try {
        next = await work({ signal: ac.signal, show });
      } catch (e) {
        console.error(e);
        next = { kind: 'error', title: 'Something went wrong', message: describe(e), retry: null, shareInstead: null };
      } finally {
        void lock?.release().catch(() => undefined);
        ctl.current = null;
      }
      if (mounted.current) setView(next);
    })();
  };

  const cancel = () => {
    const ac = ctl.current;
    if (!ac || ac.signal.aborted) return;
    ac.abort();
    setView((v) => (v.kind === 'running' ? { ...v, stopping: true } : v));
  };

  const markDone = () => {
    markBackedUp();
    if (mounted.current) setLastBackup(readLastBackup());
    onBackedUp();
  };

  const saveBackup = () =>
    run('backup', 'Reading your projects…', async ({ signal, show }) => {
      const files = withFiles;
      let built: { summary: BackupSummary; blob: Blob; name: string } | null = null;
      try {
        const sink = new BlobSink();
        const summary = await writeBackup(appStore, sink, { files, build: BUILD_ID, signal, onProgress: (_, text) => show(null, text) });
        const blob = sink.toBlob();
        const name = backupFileName(files);
        built = { summary, blob, name };
        let where: string | null = null;
        if (native) {
          const { nativeSave } = await import('../lib/native');
          show(0, 'Saving to your phone…');
          where = await nativeSave(blob, name, { signal, onProgress: (n) => show(blob.size ? n / blob.size : 1) });
        } else {
          downloadBlob(blob, name);
        }
        markDone();
        haptic('medium');
        return { kind: 'saved', saved: { ...built, where, shared: false } };
      } catch (e) {
        if (isAbort(e)) return { kind: 'home' };
        console.error(e);
        return {
          kind: 'error',
          title: 'Couldn’t save the backup',
          message: describe(e),
          retry: { kind: 'backup' },
          // The backup itself was fine: sharing doesn't need a place to save it.
          shareInstead: native && built ? { ...built, where: null, shared: false } : null,
        };
      }
    });

  const share = (saved: Saved) =>
    run('share', 'Getting your backup ready…', async ({ signal, show }) => {
      try {
        const { nativeShare } = await import('../lib/native');
        const file = new File([saved.blob], saved.name, { type: BACKUP_MIME });
        const result = await nativeShare(file, 'ReelForge backup', { signal, onProgress: (n) => show(saved.blob.size ? n / saved.blob.size : 1) });
        if (result === 'shared') markDone();
        return { kind: 'saved', saved: { ...saved, shared: saved.shared || result === 'shared' } };
      } catch (e) {
        if (isAbort(e)) return { kind: 'saved', saved };
        console.error(e);
        return { kind: 'error', title: 'Couldn’t share the backup', message: describe(e), retry: { kind: 'share', saved }, shareInstead: null };
      }
    });

  const restore = (opened: OpenedBackup, name: string) =>
    run('restore', 'Getting ready…', async ({ signal, show }) => {
      try {
        const summary = await restoreBackup(opened, appStore, { signal, onProgress: (p, text) => show(p, text) });
        haptic('medium');
        return { kind: 'restored', opened, name, summary };
      } catch (e) {
        if (isAbort(e)) return { kind: 'restored', opened, name, summary: null };
        console.error(e);
        return {
          kind: 'error',
          title: 'Couldn’t restore the backup',
          message: `${describe(e)} Whatever was already restored is kept.`,
          retry: { kind: 'restore', opened, name },
          shareInstead: null,
        };
      } finally {
        onRestored();
      }
    });

  const choose = () => {
    if (ctl.current) return;
    const tap = ++pickTaps.current;
    // The picker has to open synchronously inside the tap.
    void pickFiles(native ? '*/*' : `${BACKUP_EXTENSION},${BACKUP_MIME}`, false).then((files) => {
      const file = files[0];
      // Not every engine reports a dismissed picker, so a newer tap replaces one that never answered.
      if (!file || !mounted.current || tap !== pickTaps.current) return;
      run('check', 'Checking the backup…', async ({ signal }) => {
        try {
          const opened = await openBackup(file);
          return signal.aborted ? { kind: 'home' } : { kind: 'preview', opened, name: file.name };
        } catch (e) {
          console.error(e);
          return { kind: 'error', title: 'Can’t use this file', message: describe(e), retry: { kind: 'pick' }, shareInstead: null };
        }
      });
    });
  };

  const retry = (r: Retry) => {
    if (r.kind === 'backup') saveBackup();
    else if (r.kind === 'pick') choose();
    else if (r.kind === 'restore') restore(r.opened, r.name);
    else share(r.saved);
  };

  const home = () => setView({ kind: 'home' });

  let body: ReactNode;

  // ------------------------------------------------------------------ running
  if (view.kind === 'running') {
    body = (
      <div className="run-view">
        <p className="run-title" role="status">
          {view.stopping ? 'Stopping…' : view.label}
        </p>
        <div className="big-value" aria-hidden>
          {view.progress === null ? '\u00a0' : `${Math.floor(view.progress * 100)}%`}
        </div>
        <Progress value={view.progress} label="Progress" />
        <p className="note">Keep ReelForge open with the screen on until it’s done.</p>
        <button className="secondary-btn block" disabled={view.stopping} onClick={cancel}>
          Cancel
        </button>
      </div>
    );

    // ------------------------------------------------------------------ preview
  } else if (view.kind === 'preview') {
    const { opened } = view;
    const { index } = opened;
    const rows = backupRows({ projects: index.projects.length, media: index.media.length, clips: index.clips.length }, index.files, formatBytes(opened.source.size));
    body = (
      <>
        <div className="run-view">
          <p className="run-title">Backup from {when(index.createdAt)}</p>
        </div>
        <Rows rows={rows} />
        {!index.files && (
          <p className="note">
            This backup has projects and settings only. Projects that use videos or photos won’t show them unless those files are already on this phone.
          </p>
        )}
        <p className="note">Restoring only adds to what’s on this phone. Nothing is deleted, and a project is replaced only if the backup has a newer copy of it.</p>
        <button className="primary-btn block" onClick={() => restore(opened, view.name)}>
          <ArchiveRestore size={20} aria-hidden />
          Restore
        </button>
        <button className="text-btn" onClick={home}>
          Cancel
        </button>
      </>
    );

    // ------------------------------------------------------------------ saved
  } else if (view.kind === 'saved') {
    const { saved } = view;
    const { summary } = saved;
    body = (
      <>
        <p className="note">{saved.where ?? (native ? saved.name : `Look for ${saved.name} in your browser’s downloads.`)}</p>
        <Rows rows={backupRows(summary, summary.files, formatBytes(summary.bytes))} />
        <MissingNote n={summary.missing} />
        <p className="note">Keep a copy somewhere safe, like Google Drive or your computer. A backup that lives only on this phone is lost along with the phone.</p>
        {native && (
          <button className="primary-btn block" onClick={() => share(saved)}>
            <Share size={20} aria-hidden />
            {saved.shared ? 'Share again' : 'Share a copy'}
          </button>
        )}
        <button className={native ? 'text-btn' : 'primary-btn block'} onClick={onClose}>
          Done
        </button>
      </>
    );

    // ------------------------------------------------------------------ restored
  } else if (view.kind === 'restored') {
    const r = view.summary;
    if (!r) {
      body = (
        <>
          <p className="note">Restore stopped. What was already copied is kept; restore again to finish the rest.</p>
          <button className="primary-btn block" onClick={() => restore(view.opened, view.name)}>
            <ArchiveRestore size={20} aria-hidden />
            Restore again
          </button>
          <button className="text-btn" onClick={onClose}>
            Done
          </button>
        </>
      );
    } else {
      const rows = (
        [
          ['Projects restored', r.projects.added],
          ['Projects updated', r.projects.updated],
          ['Videos, photos and audio', r.media.added],
          ['Clips', r.clips.added],
          ['Folders', r.folders],
          ['Settings', r.settings],
        ] as [string, number][]
      ).filter(([, n]) => n > 0);
      body = (
        <>
          {rows.length > 0 ? <Rows rows={rows} /> : <p className="note">Everything in this backup is already on this phone.</p>}
          {r.incomplete > 0 && (
            <p className="note">
              {r.incomplete} restored {r.incomplete === 1 ? 'project uses' : 'projects use'} videos or photos that this backup doesn’t have.
            </p>
          )}
          {r.dropped > 0 && (
            <p className="note">
              {r.dropped} {r.dropped === 1 ? 'item' : 'items'} in the file couldn’t be read and {r.dropped === 1 ? 'was' : 'were'} skipped.
            </p>
          )}
          <button className="primary-btn block" onClick={onClose}>
            Done
          </button>
        </>
      );
    }

    // ------------------------------------------------------------------ error
  } else if (view.kind === 'error') {
    const { shareInstead, retry: again } = view;
    const backTo: View = again?.kind === 'share' ? { kind: 'saved', saved: again.saved } : { kind: 'home' };
    body = (
      <>
        <div className="run-view">
          <p className="run-title">{view.title}</p>
          <p className="error-text" role="alert">
            {view.message}
          </p>
        </div>
        {again && (
          <button className="primary-btn block" onClick={() => retry(again)}>
            {again.kind === 'pick' ? 'Choose another file' : 'Try again'}
          </button>
        )}
        {shareInstead && (
          <button className="secondary-btn block" onClick={() => share(shareInstead)}>
            <Share size={20} aria-hidden />
            Share it instead
          </button>
        )}
        <button className="text-btn" onClick={() => setView(backTo)}>
          Back
        </button>
      </>
    );

    // ------------------------------------------------------------------ home
  } else {
    const empty = estimate !== null && estimate !== 'unreadable' && estimate.projects === 0 && estimate.media === 0 && estimate.clips === 0;
    body = (
      <>
        <p className="note">
          A backup is one file with your projects, videos, photos and clips. Keep it safe and you can bring everything back after a reinstall, or on a new phone.
        </p>
        <p className="note">{lastBackup ? <>Last backup: <b>{ago(lastBackup)}</b></> : 'You haven’t made a backup yet.'}</p>
        <Toggle checked={withFiles} onChange={setWithFiles} label="Include videos, photos and clips" hint="Turn off to save only your project layouts and settings." />
        {estimate === null ? (
          <p className="note">Counting what’s on this phone…</p>
        ) : estimate === 'unreadable' ? (
          <p className="error-text" role="alert">
            Couldn’t read your projects from this phone.
          </p>
        ) : empty ? (
          <p className="note">There’s nothing to back up yet. Make a project or save a clip first.</p>
        ) : (
          <>
            <Rows rows={backupRows(estimate, withFiles, withFiles ? `≈ ${formatBytes(estimate.bytes)}` : null)} />
            <MissingNote n={estimate.missing} />
          </>
        )}
        <button className="primary-btn block" disabled={empty} onClick={saveBackup}>
          <DatabaseBackup size={20} aria-hidden />
          {native ? 'Save a backup' : 'Download a backup'}
        </button>
        <button className="secondary-btn block" onClick={choose}>
          <FolderOpen size={20} aria-hidden />
          Restore from a backup
        </button>
        {native && (
          <p className="note">
            Updating ReelForge? Install the new version right over this one and everything stays. Don’t uninstall first: that deletes what the app has stored.
          </p>
        )}
      </>
    );
  }

  return (
    <Sheet title={titleOf(view)} onClose={onClose} tall closeIcon="x" busy={view.kind === 'running' ? BUSY[view.job] : null}>
      {body}
    </Sheet>
  );
}
