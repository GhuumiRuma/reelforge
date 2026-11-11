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

export const appStore: BackupStore = {
  async getSetting(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
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
  listProjects,
  getProject,
  saveProject,
  listFolders,
  putFolder,
  hasMedia,
  getMedia,
  putMedia,
  clipIds: listClipIds,
  getClip,
  putClip,
};
