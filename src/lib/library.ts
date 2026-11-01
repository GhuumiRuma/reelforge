/**
 * The clip library as the editor sees it: saved clips become files, and files become project media.
 */
import type { MediaAsset } from '../types';
import { getClip, hasMedia, putMedia, type ClipRecord } from './db';
import { ensurePeaks, ensureThumbs, loadAssets, probe, registerAsset } from './media';
import { safeFileName } from './util';

function recordFile(rec: ClipRecord): File {
  const ext = rec.meta.fileName.split('.').pop() ?? (rec.meta.kind === 'audio' ? 'm4a' : 'mp4');
  return new File([rec.blob], `${safeFileName(rec.meta.name, 'Clip')}.${ext}`, { type: rec.meta.mime });
}

/** A saved clip as a file named after the clip, for sharing, saving or editing. */
export async function clipFile(id: string): Promise<File | null> {
  const rec = await getClip(id);
  return rec ? recordFile(rec) : null;
}

/** The project media ID of a library clip. It never changes, so using a clip again reuses one stored copy. */
export const clipAssetId = (clipId: string) => `m_${clipId}`;

/** Makes a library clip usable as project media, storing it once. Null when the clip was deleted. */
export async function importClip(clipId: string): Promise<MediaAsset | null> {
  const id = clipAssetId(clipId);
  let asset: MediaAsset | undefined;
  // Ask the database, not only memory: deleting a project removes media no other project uses.
  if (await hasMedia(id)) asset = (await loadAssets([id]))[id];
  if (!asset) {
    const rec = await getClip(clipId);
    if (!rec) return null;
    const file = recordFile(rec);
    asset = { ...(await probe(file, file.name, file.type)), id };
    await putMedia(asset, file);
    registerAsset(asset, file);
  }
  void ensureThumbs(id);
  if (asset.hasAudio) void ensurePeaks(id);
  return asset;
}
