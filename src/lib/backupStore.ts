/**
 * The app's own storage as a backup sees it: IndexedDB for projects, files and clips, localStorage for
 * the few preferences worth carrying over. `backup.ts` only knows the `BackupStore` shape.
 */
import { parseLook } from '../state/appearance';
import { LOOK_KEY, parsePref, setLook, setThemePref, THEME_KEY } from '../state/theme';
import type { BackupStore } from './backup';
import {
  getClip,
  getMedia,
  getProject,
  hasMedia,
  listClipIds,
  listFolders,
  listProjects,
  putClip,
  putFolder,
  putMedia,
  saveProject,
} from './db';

/**
 * Production implementation of the backup store contract.
 *
 * Metadata and media go through the IndexedDB facade, while portable preferences use
 * localStorage. Appearance setters are special because restored values must also affect the
 * running page rather than waiting for the next launch.
 */
export const appStore: BackupStore = {
  /** Reads a portable preference, treating inaccessible browser storage as absent. */
  async getSetting(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  /**
   * Restores one preference and applies appearance changes immediately when needed.
   *
   * Browser storage failures are intentionally ignored so the rest of a backup can restore.
   */
  async setSetting(key, value) {
    // The theme and the look also have to be applied now, not just saved for the next launch. The look is
    // rebuilt from its choices, never copied: index.html applies the CSS saved with a look as it is.
    if (key === THEME_KEY) {
      setThemePref(parsePref(value));
      return;
    }
    if (key === LOOK_KEY) {
      setLook(parseLook(value));
      return;
    }
    try {
      localStorage.setItem(key, value);
    } catch {
      // Blocked or full storage: the backup still restores everything else.
    }
  },
  /** Reads saved project documents in their normal newest-first display order. */
  listProjects,
  /** Reads a project by ID, returning `undefined` when it is absent. */
  getProject,
  /** Writes a complete project document under its stable ID. */
  saveProject,
  /** Reads all clip folders in display order. */
  listFolders,
  /** Inserts or replaces a folder document. */
  putFolder,
  /** Checks media existence without materializing a blob. */
  hasMedia,
  /** Reads the metadata and blob for a media record. */
  getMedia,
  /** Inserts or replaces a media record. */
  putMedia,
  /** Lists only clip IDs, avoiding transfer of large clip bodies. */
  clipIds: listClipIds,
  /** Reads a complete clip record. */
  getClip,
  /** Inserts or replaces a complete clip record. */
  putClip,
};
