/**
 * IndexedDB persistence facade for ReelForge's projects, source media, derived media caches, and
 * clip library.
 *
 * Records stay local to the browser/app origin. Public helpers serialize complete projects and
 * blobs without sharing database connections outside this module, and the schema upgrade keeps
 * version 1 data readable when clip-library version 2 stores are introduced.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { ClipFolder, ClipMeta, MediaAsset, Project } from '../types';
import { allItems } from './layout';

/** Cached timeline thumbnail strip, keyed by the source media ID. */
export interface ThumbRecord {
  id: string;
  /** seconds between thumbnails */
  interval: number;
  blobs: Blob[];
}

/** Cached normalized waveform samples, keyed by the source media ID. */
export interface PeakRecord {
  id: string;
  /** peak values per second */
  rate: number;
  data: Uint8Array;
}

/** Exact object stores and key paths used by the versioned `reelforge` database. */
interface RFSchema extends DBSchema {
  projects: { key: string; value: Project };
  media: { key: string; value: { asset: MediaAsset; blob: Blob } };
  thumbs: { key: string; value: ThumbRecord };
  peaks: { key: string; value: PeakRecord };
  clips: { key: string; value: ClipRecord };
  folders: { key: string; value: ClipFolder };
}

/** A complete saved clip: immutable bytes plus editable library metadata and optional video poster. */
export interface ClipRecord {
  meta: ClipMeta;
  blob: Blob;
  /** a JPEG frame for video clips */
  poster: Blob | null;
}

/** Shared lazy-open promise, preventing concurrent callers from opening duplicate connections. */
let dbp: Promise<IDBPDatabase<RFSchema>> | null = null;

/**
 * Opens the local `reelforge` database once and applies in-order schema upgrades.
 *
 * Version 1 establishes projects, media, thumbnails, and waveforms; version 2 adds clip and folder
 * stores. Callers receive the same promise connection. IndexedDB/open errors reject and are left
 * for the caller or backup UI to present.
 */
export function db(): Promise<IDBPDatabase<RFSchema>> {
  dbp ??= openDB<RFSchema>('reelforge', 2, {
    upgrade(d, oldVersion) {
      if (oldVersion < 1) {
        d.createObjectStore('projects', { keyPath: 'id' });
        d.createObjectStore('media');
        d.createObjectStore('thumbs', { keyPath: 'id' });
        d.createObjectStore('peaks', { keyPath: 'id' });
      }
      if (oldVersion < 2) {
        d.createObjectStore('clips', { keyPath: 'meta.id' });
        d.createObjectStore('folders', { keyPath: 'id' });
      }
    },
  });
  return dbp;
}

/** Lists complete saved project documents, ordered by descending update time. */
export async function listProjects(): Promise<Project[]> {
  const all = await (await db()).getAll('projects');
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** Reads a project by stable ID; missing records resolve to `undefined`. */
export async function getProject(id: string): Promise<Project | undefined> {
  return (await db()).get('projects', id);
}

/** Inserts or replaces a complete project document using its `id` key path. */
export async function saveProject(p: Project): Promise<void> {
  await (await db()).put('projects', p);
}

/**
 * Deletes a project and then garbage-collects unreferenced source-media records and their caches.
 * Errors from either transaction reject to the caller.
 */
export async function deleteProject(id: string): Promise<void> {
  await (await db()).delete('projects', id);
  await gcMedia();
}

/** Stores source bytes with a metadata snapshot under `asset.id`. */
export async function putMedia(asset: MediaAsset, blob: Blob): Promise<void> {
  await (await db()).put('media', { asset, blob }, asset.id);
}

/** Reads source metadata and its blob, or `undefined` if the ID is no longer stored. */
export async function getMedia(id: string): Promise<{ asset: MediaAsset; blob: Blob } | undefined> {
  return (await db()).get('media', id);
}

/** Checks media existence without transferring the source blob from IndexedDB. */
export async function hasMedia(id: string): Promise<boolean> {
  return (await (await db()).getKey('media', id)) !== undefined;
}

/** Reads a previously generated thumbnail strip, if available. */
export async function getThumbs(id: string): Promise<ThumbRecord | undefined> {
  return (await db()).get('thumbs', id);
}

/** Inserts or replaces the cached thumbnail strip for a media ID. */
export async function putThumbs(rec: ThumbRecord): Promise<void> {
  await (await db()).put('thumbs', rec);
}

/** Reads cached normalized waveform data, if available. */
export async function getPeaks(id: string): Promise<PeakRecord | undefined> {
  return (await db()).get('peaks', id);
}

/** Inserts or replaces the cached waveform for a media ID. */
export async function putPeaks(rec: PeakRecord): Promise<void> {
  await (await db()).put('peaks', rec);
}

// ---------------------------------------------------------------------------
// Clip library

/** Every clip's details, without loading the files. */
/**
 * Reads every clip's editable metadata and poster by cursor.
 *
 * Clip blobs are intentionally omitted to keep library listing responsive and memory-bounded.
 */
export async function listClips(): Promise<{ meta: ClipMeta; poster: Blob | null }[]> {
  const d = await db();
  const out: { meta: ClipMeta; poster: Blob | null }[] = [];
  let cur = await d.transaction('clips').store.openCursor();
  while (cur) {
    out.push({ meta: cur.value.meta, poster: cur.value.poster });
    cur = await cur.continue();
  }
  return out;
}

/** The id of every clip in the library, without loading the files. */
export async function listClipIds(): Promise<string[]> {
  return (await db()).getAllKeys('clips');
}

/** Reads a complete clip record, including its potentially large source blob. */
export async function getClip(id: string): Promise<ClipRecord | undefined> {
  return (await db()).get('clips', id);
}

/** Inserts or replaces a complete clip record, keyed by `meta.id`. */
export async function putClip(rec: ClipRecord): Promise<void> {
  await (await db()).put('clips', rec);
}

/**
 * Atomically patches one clip's metadata while preserving its blobs.
 * The stored ID is forced to match `id`, and a missing record is a no-op.
 */
export async function updateClipMeta(id: string, patch: Partial<ClipMeta>): Promise<void> {
  const d = await db();
  const tx = d.transaction('clips', 'readwrite');
  const rec = await tx.store.get(id);
  if (rec) await tx.store.put({ ...rec, meta: { ...rec.meta, ...patch, id } });
  await tx.done;
}

/** Deletes a saved clip record without affecting source media used by projects. */
export async function deleteClip(id: string): Promise<void> {
  await (await db()).delete('clips', id);
}

/** Lists all folders in locale-aware ascending name order. */
export async function listFolders(): Promise<ClipFolder[]> {
  const all = await (await db()).getAll('folders');
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

/** Inserts or replaces a clip folder, keyed by its ID. */
export async function putFolder(f: ClipFolder): Promise<void> {
  await (await db()).put('folders', f);
}

/** Deletes a folder; its clips stay in the library, unfiled. */
export async function deleteFolder(id: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(['folders', 'clips'], 'readwrite');
  await tx.objectStore('folders').delete(id);
  let cur = await tx.objectStore('clips').openCursor();
  while (cur) {
    if (cur.value.meta.folderId === id) await cur.update({ ...cur.value, meta: { ...cur.value.meta, folderId: null } });
    cur = await cur.continue();
  }
  await tx.done;
}

/**
 * Collects every media ID referenced anywhere in a project's tracks.
 * A set de-duplicates repeated uses without depending on track kind.
 */
export function projectMediaIds(p: Project): string[] {
  const ids = new Set<string>();
  for (const it of allItems(p)) if ('mediaId' in it) ids.add(it.mediaId);
  return [...ids];
}

/** Removes media that no saved project references. */
export async function gcMedia(keep: string[] = []): Promise<void> {
  const d = await db();
  const projects = await d.getAll('projects');
  const used = new Set<string>(keep);
  for (const p of projects) for (const id of projectMediaIds(p)) used.add(id);
  const keys = await d.getAllKeys('media');
  for (const k of keys) {
    if (used.has(k)) continue;
    await d.delete('media', k);
    await d.delete('thumbs', k);
    await d.delete('peaks', k);
  }
}

/**
 * Requests origin storage quota information and persistence status from the browser.
 *
 * Unsupported or denied StorageManager APIs resolve to zeros/false instead of failing the app.
 * Values are estimates supplied by the browser, not a sum of IndexedDB records.
 */
export async function storageInfo(): Promise<{ usage: number; quota: number; persisted: boolean }> {
  try {
    const est = await navigator.storage?.estimate?.();
    const persisted = (await navigator.storage?.persisted?.()) ?? false;
    return { usage: est?.usage ?? 0, quota: est?.quota ?? 0, persisted };
  } catch {
    return { usage: 0, quota: 0, persisted: false };
  }
}

/**
 * Best-effort request for persistent storage protection on browsers that support it.
 * User-agent denial and unsupported APIs are intentionally swallowed.
 */
export async function requestPersistence(): Promise<void> {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch {
    /* not supported */
  }
}
