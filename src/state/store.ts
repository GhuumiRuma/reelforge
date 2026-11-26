/**
 * Central editor model. Project mutations, selection, sheets, history and saves
 * live in `useEditor`, while the high-frequency playback clock is isolated in
 * `useTime` so timeline animation does not re-render the whole editor.
 */
import { create } from 'zustand';
import { produce, setAutoFreeze, type Draft } from 'immer';
import type { Project } from '../types';
import { findItem, normalize, projectDuration } from '../lib/layout';
import { saveProject } from '../lib/db';
import { debounce } from '../lib/util';

// The preview/export engines only read projects; skipping deep-freeze keeps big edits fast.
setAutoFreeze(false);

const HISTORY = 100;
const MERGE_MS = 1500;

export type SheetId =
  | 'media'
  | 'overlay'
  | 'audio'
  | 'text'
  | 'captions'
  | 'stickers'
  | 'canvas'
  | 'export'
  | 'speed'
  | 'volume'
  | 'animation'
  | 'filters'
  | 'adjust'
  | 'crop'
  | 'motion'
  | 'mask'
  | 'opacity'
  | 'chroma'
  | 'transition'
  | 'textEdit'
  | 'textStyle'
  | 'color'
  | 'soundbite'
  | 'replace';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'success';
}

export interface Task {
  label: string;
  /** 0..1, or null for indeterminate */
  progress: number | null;
}

export interface ApplyOptions {
  /** coalesce consecutive edits with the same key (e.g. typing) into one undo step */
  merge?: string;
  /** set the selection after the edit (null clears it) */
  select?: string | null;
}

interface EditorState {
  /** The normalized, currently open project; null outside the editor route. */
  project: Project | null;
  /** ID of the selected main, overlay, text, or audio item. */
  selectedId: string | null;
  /** Active editor sheet, rendered centrally by the SheetHost. */
  sheet: SheetId | null;
  /** extra context for the open sheet (e.g. the clip a transition belongs to) */
  sheetArg: string | null;
  past: Project[];
  future: Project[];
  /** project snapshot taken when a continuous gesture (drag, slider) started */
  gestureBase: Project | null;
  /** timeline zoom in pixels per second */
  zoom: number;
  toasts: Toast[];
  task: Task | null;

  /** Opens a normalized project and resets editor-local selection/history state. */
  open(p: Project): void;
  /** Flushes pending persistence and clears project-local state before leaving. */
  close(): void;
  /** Applies an Immer edit, normalizes it, records history, and schedules saving. */
  apply(recipe: (p: Draft<Project>) => void, opts?: ApplyOptions): void;
  /** Captures the project snapshot from which a continuous UI gesture is derived. */
  beginGesture(): void;
  /** Commits one history step for a changed continuous gesture. */
  endGesture(): void;
  /** Restores the previous snapshot unless a continuous gesture is active. */
  undo(): void;
  /** Re-applies the next future snapshot unless a continuous gesture is active. */
  redo(): void;
  /** Selects an existing item and closes item-specific sheets when appropriate. */
  select(id: string | null): void;
  /** Opens a sheet and optionally associates it with a target item ID. */
  openSheet(sheet: SheetId, arg?: string | null): void;
  /** Closes the sheet, finishing an active continuous gesture first. */
  closeSheet(): void;
  /** Clamps and stores timeline pixels-per-second zoom. */
  setZoom(z: number): void;
  /** Adds a bounded toast and schedules severity-specific automatic dismissal. */
  toast(text: string, kind?: Toast['kind']): void;
  /** Removes a toast by its monotonic ID. */
  dismissToast(id: number): void;
  /** Publishes or clears app-wide progress for the global task pill. */
  setTask(t: Task | null): void;
}

let mergeKey: string | null = null;
let mergeAt = 0;
let toastSeq = 0;

let pending: Project | null = null;

/** Writes the newest pending debounce snapshot, adding the last-save timestamp. */
function saveNow() {
  const p = pending;
  if (!p) return;
  pending = null;
  void saveProject({ ...p, updatedAt: Date.now() }).catch((e) => {
    console.error('save failed', e);
    useEditor.getState().toast('Could not save: device storage may be full', 'error');
  });
}

const saveLater = debounce(saveNow, 600);

/** Coalesces rapid project edits into a single delayed IndexedDB save. */
function persist(p: Project) {
  pending = p;
  saveLater();
}

/** Writes any pending project changes immediately. */
export function flushSave() {
  saveNow();
}

/** Rejects stale item selections after an edit, undo, redo, or project replacement. */
function validSelection(p: Project | null, id: string | null): string | null {
  return p && id && findItem(p, id) ? id : null;
}

/**
 * Zustand store for project lifecycle and durable editor edits. Every action reads
 * the latest state through `get` so imperative callbacks do not close over stale
 * React renders, and project changes are normalized before becoming observable.
 */
export const useEditor = create<EditorState>()((set, get) => ({
  project: null,
  selectedId: null,
  sheet: null,
  sheetArg: null,
  past: [],
  future: [],
  gestureBase: null,
  zoom: 60,
  toasts: [],
  task: null,

  /** Normalize the loaded project and establish a fresh undo timeline and zoom. */
  open(p) {
    const proj = produce(p, (d) => normalize(d as Project));
    mergeKey = null;
    set({
      project: proj,
      selectedId: null,
      sheet: null,
      sheetArg: null,
      past: [],
      future: [],
      gestureBase: null,
      zoom: initialZoom(proj),
    });
  },

  /** Save once before dropping all state that belongs to the active project. */
  close() {
    saveNow();
    set({ project: null, selectedId: null, sheet: null, sheetArg: null, past: [], future: [], gestureBase: null, task: null });
  },

  /**
   * Produce a normalized immutable project. During gestures one initial snapshot
   * is retained; otherwise equivalent `merge` edits coalesce into one history step.
   */
  apply(recipe, opts = {}) {
    const { project, gestureBase, past, selectedId } = get();
    if (!project) return;
    const next = produce(project, (d) => {
      recipe(d);
      normalize(d as Project);
    });
    if (next === project) {
      if (opts.select !== undefined) set({ selectedId: validSelection(project, opts.select) });
      return;
    }
    let nextPast = past;
    let future = get().future;
    if (!gestureBase) {
      const now = performance.now();
      const merging = !!opts.merge && opts.merge === mergeKey && now - mergeAt < MERGE_MS;
      if (!merging) {
        nextPast = [...past, project].slice(-HISTORY);
        future = [];
      }
      mergeKey = opts.merge ?? null;
      mergeAt = now;
    }
    const sel = opts.select !== undefined ? opts.select : selectedId;
    set({ project: next, past: nextPast, future, selectedId: validSelection(next, sel) });
    persist(next);
  },

  /** Record the immutable project state that subsequent drag/slider writes restore from. */
  beginGesture() {
    const { project, gestureBase } = get();
    if (project && !gestureBase) set({ gestureBase: project });
  },

  /** Turn the gesture's accumulated result into a single undo entry, if it changed. */
  endGesture() {
    const { project, gestureBase, past } = get();
    if (!gestureBase) return;
    mergeKey = null;
    if (project && project !== gestureBase) {
      set({ gestureBase: null, past: [...past, gestureBase].slice(-HISTORY), future: [] });
    } else set({ gestureBase: null });
  },

  /** Move one project snapshot from past to future and validate the selection. */
  undo() {
    const { project, past, future, selectedId, gestureBase } = get();
    if (!project || !past.length || gestureBase) return;
    const prev = past[past.length - 1];
    mergeKey = null;
    set({
      project: prev,
      past: past.slice(0, -1),
      future: [project, ...future].slice(0, HISTORY),
      selectedId: validSelection(prev, selectedId),
    });
    persist(prev);
  },

  /** Move one future snapshot back into the project and past history. */
  redo() {
    const { project, past, future, selectedId, gestureBase } = get();
    if (!project || !future.length || gestureBase) return;
    const next = future[0];
    mergeKey = null;
    set({
      project: next,
      past: [...past, project].slice(-HISTORY),
      future: future.slice(1),
      selectedId: validSelection(next, selectedId),
    });
    persist(next);
  },

  /** Select only an item still present in the normalized project; retain root sheets. */
  select(id) {
    const { project, selectedId, sheet } = get();
    const v = validSelection(project, id);
    if (v === selectedId) return;
    // Item-specific sheets make no sense once the selection changes.
    const keep = sheet && ROOT_SHEETS.has(sheet) ? sheet : null;
    set({ selectedId: v, sheet: keep, sheetArg: keep ? get().sheetArg : null });
  },

  /** Publish the sheet and its optional item/context argument to SheetHost. */
  openSheet(sheet, arg = null) {
    set({ sheet, sheetArg: arg });
  },

  /** Close an open sheet after giving any active gesture a chance to commit history. */
  closeSheet() {
    if (get().gestureBase) get().endGesture();
    set({ sheet: null, sheetArg: null });
  },

  /** Store timeline zoom within the limits understood by drawing and gesture math. */
  setZoom(z) {
    set({ zoom: Math.min(800, Math.max(8, z)) });
  },

  /** Add at most three recent toasts and remove this one on a kind-specific timer. */
  toast(text, kind = 'info') {
    const id = ++toastSeq;
    set({ toasts: [...get().toasts.slice(-2), { id, text, kind }] });
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 5000 : 2600);
  },

  /** Remove one toast without disturbing newer messages. */
  dismissToast(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },

  /** Replace the single global long-running-task status. */
  setTask(t) {
    set({ task: t });
  },
}));

const ROOT_SHEETS = new Set<SheetId>(['media', 'overlay', 'audio', 'text', 'captions', 'stickers', 'canvas', 'export']);

/** Chooses an opening zoom that approximately fits 80% of the current viewport. */
function initialZoom(p: Project): number {
  const d = projectDuration(p);
  if (d <= 0) return 60;
  const w = typeof window !== 'undefined' ? window.innerWidth : 400;
  return Math.min(200, Math.max(10, (w * 0.8) / d));
}

/** Flush pending saves when the app is backgrounded or closed (iOS may kill it at any moment). */
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', saveNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNow();
  });
}

/** Playback position, updated every frame; kept separate so the editor doesn't re-render at 60 fps. */
export const useTime = create<{ time: number; playing: boolean }>()(() => ({ time: 0, playing: false }));

/** Imperative toast helper for non-React modules and asynchronous operations. */
export const toast = (text: string, kind?: Toast['kind']) => useEditor.getState().toast(text, kind);

/** Looks up the selected item and its track/index without subscribing to playback time. */
export function selectedItem(s: Pick<EditorState, 'project' | 'selectedId'>) {
  return s.project && s.selectedId ? findItem(s.project, s.selectedId) : null;
}
