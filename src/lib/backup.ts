/**
 * Backup and restore. A backup is one `.rfbackup` file with everything ReelForge keeps on the phone:
 * projects, the video, photo and audio files they use, the clip library and a few settings.
 *
 * Layout, all numbers little-endian:
 *
 *   "RFBACKUP"  u32 format  [file data, back to back]  [index, UTF-8 JSON]  u32 index length  "RFBACKUP"
 *
 * The index goes last so a backup is written in one pass without holding the files in memory, and the
 * closing marker means a file that stopped part-way (full phone, app closed) is rejected instead of
 * being restored half-empty.
 *
 * Restoring merges. Whatever is already on the phone stays as it is; the backup only adds what's
 * missing, plus a newer copy of a project. So restoring can be repeated or resumed safely.
 *
 * This module has no browser dependencies: it works against a `BackupStore`, which is IndexedDB and
 * localStorage in the app and a plain object in the tests.
 */
import { ASPECTS, type ClipFolder, type ClipMeta, type MediaAsset, type Project } from '../types';
import { projectMediaIds, type ClipRecord } from './db';

export const BACKUP_EXTENSION = '.rfbackup';
export const BACKUP_MIME = 'application/octet-stream';

/** Preferences kept in localStorage that are worth carrying over to another install. */
export const SETTING_KEYS = ['rf-theme', 'rf-look', 'rf-text-style', 'rf-studio', 'rf-export', 'rf-captions'] as const;

const MAGIC = new TextEncoder().encode('RFBACKUP');
const FORMAT = 1;
/** magic + format */
const HEAD = MAGIC.length + 4;
/** index length + magic */
const TAIL = 4 + MAGIC.length;
/** A real index is a few megabytes at most; anything bigger is a damaged file. */
const MAX_INDEX = 256 * 1024 * 1024;

export interface BlobRef {
  offset: number;
  size: number;
  type: string;
}

export interface BackupIndex {
  app: 'reelforge';
  format: number;
  createdAt: number;
  /** which build of the app wrote it, for support */
  build: string;
  /** false when videos, photos and clips were left out */
  files: boolean;
  settings: Record<string, string>;
  folders: ClipFolder[];
  projects: Project[];
  media: { asset: MediaAsset; file: BlobRef }[];
  clips: { meta: ClipMeta; file: BlobRef; poster: BlobRef | null }[];
}

/** Everything a backup reads and a restore writes. */
export interface BackupStore {
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  listProjects(): Promise<Project[]>;
  getProject(id: string): Promise<Project | undefined>;
  saveProject(p: Project): Promise<void>;
  listFolders(): Promise<ClipFolder[]>;
  putFolder(f: ClipFolder): Promise<void>;
  hasMedia(id: string): Promise<boolean>;
  getMedia(id: string): Promise<{ asset: MediaAsset; blob: Blob } | undefined>;
  putMedia(asset: MediaAsset, blob: Blob): Promise<void>;
  clipIds(): Promise<string[]>;
  getClip(id: string): Promise<ClipRecord | undefined>;
  putClip(rec: ClipRecord): Promise<void>;
}

/** Where a backup is written. `onBytes` reports progress while a big part is being written. */
export interface BackupSink {
  write(part: Blob | Uint8Array<ArrayBuffer>, onBytes?: (n: number) => void): Promise<void>;
}

/** Collects a backup in memory as a Blob. The pieces stay references to the stored files, not copies. */
export class BlobSink implements BackupSink {
  private parts: BlobPart[] = [];

  async write(part: Blob | Uint8Array<ArrayBuffer>, onBytes?: (n: number) => void): Promise<void> {
    this.parts.push(part);
    onBytes?.(part instanceof Blob ? part.size : part.byteLength);
  }

  toBlob(): Blob {
    return new Blob(this.parts, { type: BACKUP_MIME });
  }
}

export type BackupProblem = 'not-backup' | 'incomplete' | 'newer' | 'damaged';

export class BackupError extends Error {
  constructor(
    readonly problem: BackupProblem,
    message: string,
  ) {
    super(message);
    this.name = 'BackupError';
  }
}

const abortError = () => new DOMException('Cancelled', 'AbortError');

/** `ReelForge-backup-2026-07-14-1530.rfbackup`; the time keeps two backups on one day apart. */
export function backupFileName(files: boolean, at = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const day = `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
  return `ReelForge-backup-${day}-${p(at.getHours())}${p(at.getMinutes())}${files ? '' : '-projects-only'}${BACKUP_EXTENSION}`;
}

// ---------------------------------------------------------------------------
// Writing

export interface BackupOptions {
  /** also copy videos, photos and clips; without it the backup holds only projects and settings */
  files: boolean;
  build?: string;
  signal?: AbortSignal;
  /** `progress` goes from 0 to 1 */
  onProgress?: (progress: number, label: string) => void;
}

export interface BackupSummary {
  projects: number;
  folders: number;
  media: number;
  clips: number;
  /** files a project uses that were not on the phone any more */
  missing: number;
  /** size of the whole backup, in bytes */
  bytes: number;
  files: boolean;
}

const u32 = (n: number): Uint8Array<ArrayBuffer> => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
};

const sizeOf = (part: Blob | Uint8Array): number => (part instanceof Blob ? part.size : part.byteLength);

async function readSettings(store: BackupStore): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const key of SETTING_KEYS) {
    const v = await store.getSetting(key);
    if (v !== null) out[key] = v;
  }
  return out;
}

interface Gathered {
  projects: Project[];
  folders: ClipFolder[];
  settings: Record<string, string>;
  mediaIds: string[];
  clipIds: string[];
  /** files a project uses that were not on the phone any more */
  missing: number;
  /** what the files add up to, in bytes */
  bytes: number;
}

/**
 * Settles what a backup holds. Only files that a saved project uses are copied, which is also what the
 * app keeps when it cleans up after a delete; the clip library is copied whole.
 */
async function gather(store: BackupStore, files: boolean, check: () => void): Promise<Gathered> {
  const projects = await store.listProjects();
  const folders = await store.listFolders();
  const settings = await readSettings(store);
  const mediaIds: string[] = [];
  const clipIds: string[] = [];
  let missing = 0;
  let bytes = 0;
  if (files) {
    for (const id of new Set(projects.flatMap(projectMediaIds))) {
      check();
      const rec = await store.getMedia(id);
      if (!rec) {
        missing++;
        continue;
      }
      mediaIds.push(id);
      bytes += rec.blob.size;
    }
    for (const id of await store.clipIds()) {
      check();
      const rec = await store.getClip(id);
      if (!rec) continue;
      clipIds.push(id);
      bytes += rec.blob.size + (rec.poster?.size ?? 0);
    }
  }
  return { projects, folders, settings, mediaIds, clipIds, missing, bytes };
}

export interface BackupEstimate {
  projects: number;
  media: number;
  clips: number;
  missing: number;
  /** size of the files; the projects and settings add a little on top */
  bytes: number;
}

/** What a backup would hold right now, without writing anything. */
export async function estimateBackup(store: BackupStore, files: boolean, signal?: AbortSignal): Promise<BackupEstimate> {
  const g = await gather(store, files, () => {
    if (signal?.aborted) throw abortError();
  });
  return { projects: g.projects.length, media: g.mediaIds.length, clips: g.clipIds.length, missing: g.missing, bytes: g.bytes };
}

export async function writeBackup(store: BackupStore, sink: BackupSink, opts: BackupOptions): Promise<BackupSummary> {
  const { signal, onProgress } = opts;
  const check = () => {
    if (signal?.aborted) throw abortError();
  };

  check();
  onProgress?.(0, 'Reading your projects…');
  // What goes in is settled first, with sizes, so progress can follow the bytes.
  const gathered = await gather(store, opts.files, check);
  const { projects, folders, settings, mediaIds, clipIds, bytes: total } = gathered;
  let missing = gathered.missing;
  let offset = 0;
  let copied = 0;
  const append = async (part: Blob | Uint8Array<ArrayBuffer>, label?: string): Promise<BlobRef> => {
    const ref: BlobRef = { offset, size: sizeOf(part), type: part instanceof Blob ? part.type : '' };
    await sink.write(part, (n) => {
      copied += n;
      if (label) onProgress?.(Math.min(0.99, copied / Math.max(1, total)), label);
    });
    offset += ref.size;
    return ref;
  };

  await append(MAGIC.slice());
  await append(u32(FORMAT));

  const media: BackupIndex['media'] = [];
  for (const id of mediaIds) {
    check();
    const rec = await store.getMedia(id);
    if (!rec) {
      missing++;
      continue;
    }
    media.push({ asset: rec.asset, file: await append(rec.blob, 'Copying videos and photos…') });
  }

  const clips: BackupIndex['clips'] = [];
  for (const id of clipIds) {
    check();
    const rec = await store.getClip(id);
    if (!rec) continue;
    const file = await append(rec.blob, 'Copying clips…');
    const poster = rec.poster ? await append(rec.poster, 'Copying clips…') : null;
    clips.push({ meta: rec.meta, file, poster });
  }

  check();
  onProgress?.(0.99, 'Finishing up…');
  const index: BackupIndex = {
    app: 'reelforge',
    format: FORMAT,
    createdAt: Date.now(),
    build: opts.build ?? 'dev',
    files: opts.files,
    settings,
    folders,
    projects,
    media,
    clips,
  };
  const json = new TextEncoder().encode(JSON.stringify(index));
  await append(json);
  await append(u32(json.byteLength));
  await append(MAGIC.slice());
  onProgress?.(1, 'Done');

  return { projects: projects.length, folders: folders.length, media: media.length, clips: clips.length, missing, bytes: offset, files: opts.files };
}

// ---------------------------------------------------------------------------
// Reading

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isId = (v: unknown): v is string => isStr(v) && v.length > 0 && v.length <= 200;
const optStr = (v: unknown) => v === undefined || isStr(v);

function isFolder(v: unknown): v is ClipFolder {
  return isObj(v) && isId(v.id) && isStr(v.name) && isNum(v.createdAt);
}

function isAsset(v: unknown): v is MediaAsset {
  return (
    isObj(v) &&
    isId(v.id) &&
    isStr(v.name) &&
    (v.kind === 'video' || v.kind === 'image' || v.kind === 'audio') &&
    isStr(v.mime) &&
    isNum(v.size) &&
    isNum(v.duration) &&
    isNum(v.width) &&
    isNum(v.height) &&
    isBool(v.hasAudio) &&
    isBool(v.canDecodeVideo) &&
    isBool(v.canDecodeAudio) &&
    isNum(v.createdAt)
  );
}

function isClipMeta(v: unknown): v is ClipMeta {
  return (
    isObj(v) &&
    isId(v.id) &&
    isStr(v.name) &&
    (v.kind === 'video' || v.kind === 'audio') &&
    isStr(v.mime) &&
    isStr(v.fileName) &&
    isNum(v.size) &&
    isNum(v.duration) &&
    isNum(v.width) &&
    isNum(v.height) &&
    (v.folderId === null || isId(v.folderId)) &&
    isNum(v.start) &&
    isNum(v.end) &&
    isNum(v.createdAt) &&
    optStr(v.source) &&
    optStr(v.youtubeId) &&
    optStr(v.sourceUrl)
  );
}

const ITEM_TYPES = ['video', 'image', 'color', 'text', 'audio'];
const USES_MEDIA = ['video', 'image', 'audio'];

/** Checks the parts of an item that listing and storing projects rely on. */
function isItem(v: unknown): boolean {
  if (!isObj(v) || !isId(v.id) || !isStr(v.type) || !ITEM_TYPES.includes(v.type)) return false;
  if (!isNum(v.start) || !isNum(v.duration)) return false;
  return !USES_MEDIA.includes(v.type) || isId(v.mediaId);
}

function isProject(v: unknown): v is Project {
  if (!isObj(v) || !isId(v.id) || !isStr(v.name) || !isNum(v.createdAt) || !isNum(v.updatedAt) || !isNum(v.fps)) return false;
  if (v.version !== 1 || !ASPECTS.some((a) => a.id === v.aspect) || !isObj(v.background)) return false;
  return (['main', 'overlays', 'texts', 'audios'] as const).every((k) => {
    const list = v[k];
    return Array.isArray(list) && list.every(isItem);
  });
}

function isRef(v: unknown, dataEnd: number): v is BlobRef {
  return (
    isObj(v) &&
    Number.isInteger(v.offset) &&
    Number.isInteger(v.size) &&
    isStr(v.type) &&
    v.type.length <= 255 &&
    (v.offset as number) >= HEAD &&
    (v.size as number) >= 0 &&
    (v.offset as number) + (v.size as number) <= dataEnd
  );
}

export interface OpenedBackup {
  index: BackupIndex;
  source: Blob;
  /** entries in the file that couldn't be read and are left out */
  dropped: number;
}

const damaged = () => new BackupError('damaged', 'This backup file is damaged and can’t be restored.');

/** Reads and checks a backup file without loading its contents. Throws a BackupError for a file that can't be used. */
export async function openBackup(source: Blob): Promise<OpenedBackup> {
  const bytes = async (from: number, to: number) => new Uint8Array(await source.slice(from, to).arrayBuffer());
  const hasMagic = (b: Uint8Array, at: number) => MAGIC.every((c, i) => b[at + i] === c);

  if (source.size < HEAD + TAIL) throw new BackupError('not-backup', 'This isn’t a ReelForge backup file.');
  const head = await bytes(0, HEAD);
  if (!hasMagic(head, 0)) throw new BackupError('not-backup', 'This isn’t a ReelForge backup file.');
  const format = new DataView(head.buffer).getUint32(MAGIC.length, true);
  if (format > FORMAT) throw new BackupError('newer', 'This backup was made by a newer version of ReelForge. Update the app, then try again.');
  if (format < 1) throw damaged();

  const tail = await bytes(source.size - TAIL, source.size);
  if (!hasMagic(tail, 4)) {
    throw new BackupError('incomplete', 'This backup file is incomplete. It may not have finished saving or copying. Try making the backup again.');
  }
  const indexLength = new DataView(tail.buffer).getUint32(0, true);
  const dataEnd = source.size - TAIL - indexLength;
  if (indexLength === 0 || indexLength > MAX_INDEX || dataEnd < HEAD) throw damaged();

  let raw: unknown;
  try {
    raw = JSON.parse(await source.slice(dataEnd, source.size - TAIL).text());
  } catch {
    throw damaged();
  }
  if (!isObj(raw) || raw.app !== 'reelforge' || !isNum(raw.createdAt) || !isBool(raw.files)) throw damaged();

  let dropped = 0;
  const keep = <T>(list: unknown, ok: (v: unknown) => v is T): T[] => {
    if (!Array.isArray(list)) return [];
    const good = list.filter(ok);
    dropped += list.length - good.length;
    return good;
  };
  const settings: Record<string, string> = {};
  if (isObj(raw.settings)) for (const k of SETTING_KEYS) if (isStr(raw.settings[k])) settings[k] = raw.settings[k];

  const index: BackupIndex = {
    app: 'reelforge',
    format,
    createdAt: raw.createdAt,
    build: isStr(raw.build) ? raw.build : '',
    files: raw.files,
    settings,
    folders: keep(raw.folders, isFolder),
    projects: keep(raw.projects, isProject),
    media: keep(raw.media, (v): v is BackupIndex['media'][number] => isObj(v) && isAsset(v.asset) && isRef(v.file, dataEnd)),
    clips: keep(
      raw.clips,
      (v): v is BackupIndex['clips'][number] => isObj(v) && isClipMeta(v.meta) && isRef(v.file, dataEnd) && (v.poster === null || isRef(v.poster, dataEnd)),
    ),
  };
  return { index, source, dropped };
}

// ---------------------------------------------------------------------------
// Restoring

export interface RestoreOptions {
  signal?: AbortSignal;
  onProgress?: (progress: number, label: string) => void;
}

export interface RestoreSummary {
  projects: { added: number; updated: number; kept: number };
  media: { added: number; kept: number };
  clips: { added: number; kept: number };
  folders: number;
  settings: number;
  /** projects added that use videos or photos the backup doesn't have */
  incomplete: number;
  dropped: number;
}

export async function restoreBackup(opened: OpenedBackup, store: BackupStore, opts: RestoreOptions = {}): Promise<RestoreSummary> {
  const { index, source } = opened;
  const { signal, onProgress } = opts;
  const check = () => {
    if (signal?.aborted) throw abortError();
  };
  const summary: RestoreSummary = {
    projects: { added: 0, updated: 0, kept: 0 },
    media: { added: 0, kept: 0 },
    clips: { added: 0, kept: 0 },
    folders: 0,
    settings: 0,
    incomplete: 0,
    dropped: opened.dropped,
  };

  check();
  onProgress?.(0, 'Checking what’s already here…');
  const folderIds = new Set((await store.listFolders()).map((f) => f.id));
  const clipIds = new Set(await store.clipIds());
  const newMedia: BackupIndex['media'] = [];
  for (const m of index.media) {
    if (await store.hasMedia(m.asset.id)) summary.media.kept++;
    else newMedia.push(m);
  }
  const newClips = index.clips.filter((c) => !clipIds.has(c.meta.id));
  summary.clips.kept = index.clips.length - newClips.length;
  // Reading the file front to back is the fastest way through it.
  newMedia.sort((a, b) => a.file.offset - b.file.offset);
  newClips.sort((a, b) => a.file.offset - b.file.offset);

  const total = Math.max(1, newMedia.reduce((n, m) => n + m.file.size, 0) + newClips.reduce((n, c) => n + c.file.size + (c.poster?.size ?? 0), 0));
  let copied = 0;
  const step = (bytes: number, label: string) => {
    copied += bytes;
    onProgress?.(Math.min(0.99, copied / total), label);
  };
  const slice = (r: BlobRef) => source.slice(r.offset, r.offset + r.size, r.type);

  // Folders, then files, then the projects that use them: stopping at any point leaves nothing
  // pointing at a file that isn't there.
  for (const f of index.folders) {
    if (folderIds.has(f.id)) continue;
    await store.putFolder(f);
    folderIds.add(f.id);
    summary.folders++;
  }

  for (const m of newMedia) {
    check();
    await store.putMedia(m.asset, slice(m.file));
    summary.media.added++;
    step(m.file.size, 'Restoring videos and photos…');
  }

  for (const c of newClips) {
    check();
    const meta = c.meta.folderId && !folderIds.has(c.meta.folderId) ? { ...c.meta, folderId: null } : c.meta;
    await store.putClip({ meta, blob: slice(c.file), poster: c.poster ? slice(c.poster) : null });
    summary.clips.added++;
    step(c.file.size + (c.poster?.size ?? 0), 'Restoring clips…');
  }

  const hasAllMedia = async (p: Project) => {
    for (const id of projectMediaIds(p)) if (!(await store.hasMedia(id))) return false;
    return true;
  };
  onProgress?.(0.99, 'Restoring projects…');
  for (const p of index.projects) {
    check();
    const existing = await store.getProject(p.id);
    if (!existing) {
      await store.saveProject(p);
      summary.projects.added++;
      if (!(await hasAllMedia(p))) summary.incomplete++;
    } else if (p.updatedAt > existing.updatedAt && (await hasAllMedia(p))) {
      // A newer copy replaces the older one, but never with one that would be missing its files.
      await store.saveProject(p);
      summary.projects.updated++;
    } else {
      summary.projects.kept++;
    }
  }

  for (const key of SETTING_KEYS) {
    const value = index.settings[key];
    if (value === undefined || (await store.getSetting(key)) !== null) continue;
    await store.setSetting(key, value);
    summary.settings++;
  }

  onProgress?.(1, 'Done');
  return summary;
}
