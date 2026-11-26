# UI and editor state architecture

This guide covers the production TypeScript under `src/ui`, `src/state`, and
`src/experimental`. It describes how React screens, imperative preview/canvas code,
and Zustand state cooperate; the type and media/engine implementations are outside
this module, but their observable inputs and effects are called out where relevant.

## Runtime hierarchy

`App` selects the hash-routed top-level screen and keeps global feedback mounted:

```text
App
├─ Home | Studio | Editor
├─ TaskPill                 (useEditor.task)
├─ Toasts                   (useEditor.toasts)
└─ DialogHost               (promise-based global dialogs)

Home
├─ header: ExperimentalButton? + backup + ThemeButton
├─ update, backup-reminder, install, and codec notices
├─ project/clip actions
├─ Projects: ProjectRow + canvas Cover
├─ Clips: ClipsLibrary
└─ BackupSheet?

Studio
├─ source search or local-file selection
├─ YouTubePlayer | FilePlayer
├─ range/crop/background-removal controls
└─ progress, error, and saved-clip feedback

Editor
├─ TopBar
├─ Preview
├─ Transport
├─ Timeline
├─ Toolbar
└─ SheetHost
```

Hash routes are parsed as Home, `#/studio`, or `#/p/<id>`. `openProject` and
`openStudio` push a Home entry so `goHome` can use browser history. Sheets and
dialogs register history entries independently through `useBack`: a platform Back
or Escape closes the top surface rather than leaving the route. When a sheet is
busy, its close handler returns `false`; `useBack` re-arms the history entry so a
long operation cannot be abandoned accidentally.

## Stores and ownership

### `useEditor`

`src/state/store.ts` owns the persistent editor session:

- `project` is the current normalized `Project`; `open` resets editor-local state,
  while `close` flushes saves before clearing it.
- `selectedId` identifies an existing main, overlay, text, or audio item. Every
  apply/undo/redo validates it with `findItem`; invalid selections become `null`.
- `sheet` and `sheetArg` route sheet UI. Root sheets remain open when selection
  changes only if they do not depend on an item; item sheets close.
- `past` and `future` contain at most 100 immutable project snapshots. `apply`
  always runs through Immer and normalization and clears redo for a new edit.
- `merge` coalesces repeated edits with the same key within 1.5 seconds. This is
  used for typing and slider sequences.
- `beginGesture` captures `gestureBase`. Gesture handlers can derive absolute
  values from that immutable start snapshot while the store applies each sample to
  the latest normalized draft. `endGesture` records one undo step only if the final
  project differs from the base. Undo/redo is blocked mid-gesture.
- `zoom` is timeline pixels per second, clamped to 8–800. Its initial value tries
  to fit about 80% of the viewport to project duration.
- `toasts` is a three-entry bounded queue with automatic dismissal. `task` is the
  single global progress operation rendered by `TaskPill`.

Project changes are debounced to IndexedDB for 600 ms. `flushSave`, visibility
changes, page hide, and editor teardown use the newest pending snapshot; failed
writes become error toasts. `useTime` is intentionally separate from `useEditor`
because preview time changes every frame. It stores `time` and `playing`, while
`src/state/runtime.ts` bridges that reactive state to the currently mounted
`PreviewEngine`.

`selectedItem(state)` resolves selection to `{ item, kind, index }`. UI code uses
`useSelected` for a shallow, stable React result and `updateItem` for an undoable
item mutation. Both avoid retaining stale item objects after normalization.

### `useTheme`

`src/state/theme.ts` owns three values: the saved preference (`system`, `light`,
or `dark`), the resolved `theme`, and the validated `look` (`style`, `accent`,
`corners`). Theme/Look storage failures are non-fatal. Initial state is read once,
`initTheme` applies it at startup, and a media-query listener re-resolves System
changes.

DOM application updates `data-theme`, the `rf-look` style element, and browser
metadata. Native Android additionally updates system bars through a lazy native
import. The plain HTML pre-paint path has a serialized CSS/background copy in
storage; `refreshSavedLook` rebuilds it after app updates.

### `useApp`

`useApp` in `src/state/app.ts` intentionally holds only transient shell state:
service-worker refresh readiness, the browser install prompt, and the update
callback. Module-level install listeners preserve an event that occurs before
Home mounts and clear it after installation.

## Editor and project lifecycle

1. `Editor` enters `loading` while `getProject` and referenced media assets load.
   Missing/corrupt storage moves to the `missing` recovery screen.
2. Assets trigger asynchronous thumbnail/peak generation. Playback state is reset,
   the normalized project is opened in `useEditor`, and the screen becomes ready.
3. A Home or library action can stage files with `setPendingImport`. `Editor`
   consumes the entry exactly once. The first import's undo snapshots are pruned so
   a brand-new project cannot be undone to an unusable empty state.
4. Leaving closes the sheet and waits for its back-stack rewind to settle, flushes
   pending persistence, and routes Home. Editor effect cleanup also closes the
   store so no late load can publish into a later project.
5. Top-bar rename is a normal project edit. The resolution chip re-loads export
   preferences when the export sheet closes, and Save opens the export sheet with
   an auto-started run.

The editor's global keyboard hook ignores text fields, dialogs, and sheet controls
where appropriate. It maps Space to play/pause, Ctrl/Cmd-Z/Y to history, Ctrl/Cmd-D
to duplicate, S to split, frame/second seeking to arrows, Home/End to duration
bounds, Delete/Backspace to delete, and Escape to clear selection only when no
modal back entry is active.

## Selection, sheets, and action flow

`Toolbar` is the action dispatcher. With no selection it renders root tools; with a
selection, `useSelected` supplies the item type, track kind, and index used to build
the available command list. Tool buttons expose active sheets with `aria-expanded`
and binary modes such as keyframes/flip/fill with `aria-pressed`.

Root tools that mean "the clip" resolve `targetMain`: an explicitly selected main
clip, otherwise the main clip under the playhead. Root Media, Audio, Captions,
Stickers, Canvas, and Export sheets are track-independent. Type-specific sheets
are accepted only by `FITS` predicates in `SheetHost`. Transition and existing
text-edit sheets identify their item through `sheetArg`; `SheetHost` closes the
sheet if undo/deletion makes the target invalid.

`ui/actions.ts` is the shared command layer used by toolbar, sheets, gestures, and
keyboard shortcuts:

- project/pending imports and main/overlay insertion;
- video/image/audio construction, library clip insertion, and color clips;
- split, delete, duplicate, rotate, flip, fit, keyframe, extract-audio, soundbite,
  replace, and freeze-frame commands;
- pose sampling/writing, where existing keyframes write at local playhead time and
  unkeyframed items update base transform/opacity;
- reusable-clip encoding and persistence;
- progress, cancellation identity, wake locks, and user feedback.

Commands read `useEditor.getState()` at invocation time so asynchronous callbacks
do not capture stale React state. Operations that load a library clip retain the
project ID and do not insert after the route changed. Destructive or storage-heavy
operations surface errors through toasts or the sheet's retry state rather than
throwing into React.

## Preview, timeline, and gesture semantics

### Preview

`Preview` mounts one `PreviewEngine` for the editor route and registers it in
`state/runtime.ts`. The engine receives the latest project imperatively, reports
play time/state, and exposes frame-space visual `quads`. `Preview` converts quads
to CSS-space selection boxes, corner controls, and guides.

Tap hit testing prefers the current selection, then overlays/text, then main
media. Main taps can select/deselect, while a selected text item can open its
editor. Pointer movement:

- waits past drag slop before manipulating a free visual layer;
- captures the original item/pose/playhead-local time;
- translates movement into normalized frame deltas;
- maps pinch/corner motion to scale and rotation;
- snaps near frame-center axes and quarter-turn rotations with haptics;
- writes keyframed poses at the current local time when keyframes already exist;
- commits one `beginGesture`/`endGesture` history entry.

React refs update selection handles outside render. Engine/render/store effects
perform cleanup, remove the global engine registration, disconnect resize
observation, and dispose canvas resources. Focus mode hides manipulation controls
and makes taps toggle playback.

### Timeline

`Timeline` paints ruler, main track, free lanes, thumbnails, waveform peaks,
selection handles, keyframes, transition markers, reorder/drop feedback, and the
fixed center playhead onto one canvas. `timelinePalette` provides appearance-aware
canvas colors, cached by theme/style/accent/corners because CSS properties are not
available to 2-D drawing code.

Project time maps through:

```text
x = canvasWidth / 2 + (time - playheadTime) * zoom
```

Main-item visual spans allocate half of each transition overlap to each neighbor;
storage timing remains normalized and unchanged. Free items are grouped into
vertical lanes. Empty text/audio lanes draw actionable hints.

Gesture modes are mutually exclusive:

- horizontal drag: scrub with velocity-derived inertia;
- vertical drag over free lanes: vertical lane scroll;
- edge/body handle: trim or long-press move;
- main long press: reorder with an insertion bar;
- second pointer: pinch zoom;
- mouse wheel: time movement, zoom with Ctrl/Cmd, or vertical scrolling.

Trim starts from an immutable original item and snaps to nearby edges while
respecting source and lane bounds. It uses engine peek at the moved edge. Moving a
free item also derives a lane from pointer y; main reorder commits only on release.
Edge autoscroll continues the same gesture while the pointer is near a side. Every
continuous trim/move closes its editor gesture on release or unmount, and
cancellation does not lose the accumulated valid state.

The canvas is keyboard-focusable and acts as an ARIA slider: time updates set
`aria-valuetext`, `aria-valuenow`, and `aria-valuemax`. Thumbnail/wave updates,
window resize, editor store changes, and appearance changes all schedule one
coalesced animation-frame redraw. Listening/observer/animation cleanup is
performed on unmount.

## Sheets and heavy operations

`Sheet` centralizes dialog focus, title IDs, scrim behavior, close controls, and
browser-back registration. It focuses its root if focus is still outside, marks
tall sheets as modal, and turns busy close attempts into explanatory toasts.

- **BackupSheet** is a discriminated state machine for estimate, save, check,
  preview, restore, share, saved, restored, and error. One AbortController at a
  time owns wake locking and prevents a new job during cleanup. Partial restores
  are retained and Home is refreshed from `finally`.
- **CaptionsSheet** derives source eligibility from audible video/voice/music,
  generates locally with progress/cancel, and atomically adds or replaces
  caption text. Existing placement/style survives regeneration.
- **ExportSheet** probes the chosen dimensions, exports in a run generation,
  revokes finished object URLs, supports direct Save auto-start, and can render
  the current playhead as a still.
- **AudioSheet** serializes music/SFX/library insertion. Voiceover first primes
  microphone permission and a meter context, then records from the playhead,
  optionally plays the muted/unmuted preview, downmixes to WAV, and imports a
  voice item. Cleanup restores audio session, tracks, context, and preview mute.
- **Studio** downloads/probes sources, keeps a range/crop/background-removal
  model, and encodes the selected range into the reusable clip library. Its
  YouTube iframe only accepts messages from the expected YouTube origin and
  matching content window; local players expose the same pause/time/range
  imperative contract.

Progress `null` means indeterminate. Global `task` covers editor import/export-like
work; sheet-local busy state owns controls and copy where the operation is tied to
a modal lifecycle. Wake locks and screen-on instructions protect long runs, and
abort is cooperative so native buffers and IndexedDB work can settle.

## Appearance and theming

`appearance.ts` is the pure source of truth for style palettes, corners, accent
names, look validation, contrast adjustment, storage serialization, and override
CSS. `StyleDef` defines light/dark surfaces plus a contrast target. `accentSet`
preserves hue/saturation while moving lightness enough to satisfy text, filled
button, and selection contrast. The high-contrast style requests AAA contrast;
other styles request AA.

`themeTokens` and `sharedTokens` emit overrides only when a value differs from
the stylesheet. `lookCss` has a deliberately small character/literal vocabulary
because its serialized form can be read and applied by the pre-paint HTML path.
`ThemeButton` opens `AppearanceSheet` in a body portal. Its token-driven miniature
and style tiles call the same derivation functions as the live page. `CanvasSheet`
is a separate editor canvas/background control and should not be confused with
app appearance.

`timelineTheme.ts` converts the same `Look` into canvas-only colors, deriving grip,
surface, transition-marker, and drop colors while caching by all appearance
inputs. Corner scale applies to larger radii in both CSS and canvas.

## Accessibility and cleanup assumptions

- Sliders, segmented controls, toggles, color swatches, progress bars, sheets,
  dialogs, and menus expose roles/pressed/checked/values as applicable.
- Hidden decorative icons use `aria-hidden`; purpose-bearing icon-only buttons
  have explicit labels. Sheet titles are linked with `aria-labelledby`.
- Pointer interactions have keyboard equivalents where selection/content is
  user-editable (slider arrows, crop-box arrows, global editor shortcuts).
- Native `<video>`/`<audio>` controls remain available for finished/source preview.
- Browser object URLs, resize/media listeners, history entries, wake locks, audio
  tracks/contexts, meters, animation frames, autoplay observers, and preview
  engines are owned by the effect or job that creates them and cleaned up on
  replacement, unmount, or abort.
- Async effects use live/alive/project-ID/run-ID checks before publishing to
  avoid stale route, file-picker, model, or export responses.

## Experimental gating

`src/experimental` is shape-compatible in both builds:

- Experimental builds resolve `@experimental` to `index.ts`, which exposes
  `ExperimentalButton`.
- Public/non-experimental builds resolve it to `off.ts`, where `HomeButton` is
  `null`.
- The `Experimental` and `ExperimentalFeature` interfaces keep the alias contract
  identical. `FEATURES` is curated in the sheet, currently empty, and should list
  only behavior that is ready to try.
- `ExperimentalButton` portals `ExperimentalSheet` to `document.body`, explains
  build/project isolation, lists features, and reports the build ID.

## File, component, and action index

### State

| File | Main exports and responsibilities |
| --- | --- |
| `state/app.ts` | `useApp`, install/update shell state, `BeforeInstallPromptEvent` |
| `state/store.ts` | `useEditor`, `useTime`, `SheetId`, project history/selection/sheet/zoom/toast/task actions, `flushSave`, `selectedItem`, imperative `toast` |
| `state/runtime.ts` | `setEngine`, `getEngine`, `duration`, `seek`, `now`, `togglePlay`, `pause` |
| `state/appearance.ts` | `Look`, style/corner definitions, look parsing/merging/serialization, accent contrast, token/CSS generation |
| `state/theme.ts` | `useTheme`, preference resolution, storage, DOM/native appearance commit, `initTheme` |

### Screens, shared UI, and canvas components

| File | Main exports and responsibilities |
| --- | --- |
| `ui/Home.tsx` | `Home`, update/install/backup notices, project rows/covers, new-project handoff |
| `ui/Editor.tsx` | `Editor`, `leave`, top bar/transport/time, editor keyboard shortcuts |
| `ui/Studio.tsx` | `Studio`, source discovery/download, crop/range/save, YouTube and local players |
| `ui/Preview.tsx` | `Preview`, engine lifecycle, frame hit testing, selection overlay and pose gestures |
| `ui/Timeline.tsx` | `Timeline`, canvas drawing, scrub/zoom/scroll, trim/move/reorder and cleanup |
| `ui/Toolbar.tsx` | `Toolbar`, root/item tool descriptors and shared command dispatch |
| `ui/actions.ts` | import/insert, selection-edit, audio/pose/keyframe, freeze/replace/library/save commands |
| `ui/Clips.tsx` | `ClipsLibrary`, folder/search/filter management, clip preview/share/save/new-project actions |
| `ui/BackupSheet.tsx` | `BackupSheet`, cancellable save/check/share/restore state machine |
| `ui/AppearanceSheet.tsx` | `AppearanceSheet`, style/accent/corner previews and controls |
| `ui/BackgroundRemovalControls.tsx` | controlled color/subject cutout settings and model progress |
| `ui/ThemeButton.tsx` | header button and body-portal appearance sheet |
| `ui/common.tsx` | `useSelected`, `updateItem`, `Sheet`, `Slider`, segmented/swatch/toggle/progress controls, preference persistence |
| `ui/dialog.tsx` | `confirmDialog`, `promptDialog`, `menuDialog`, `DialogHost` |
| `ui/timelineTheme.ts` | canvas palette and contrast/corner derivation |

### Editor sheets

| File | Main exports and responsibilities |
| --- | --- |
| `ui/sheets/index.tsx` | `SheetHost`, target predicates, invalid-target closure and sheet routing |
| `ui/sheets/MediaSheet.tsx` | project/library/fresh media and color insertion for main/overlay |
| `ui/sheets/AudioSheet.tsx` | music, saved/SFX audio, original sound toggle, microphone voiceover |
| `ui/sheets/CanvasSheet.tsx` | project aspect, all-main-clip fit, background blur/color |
| `ui/sheets/CaptionsSheet.tsx` | local transcription, caption options/style/replacement, SRT export/delete |
| `ui/sheets/CropSheet.tsx` | source still loading, color picking, fractional crop geometry/pointer and keyboard edit |
| `ui/sheets/ExportSheet.tsx` | `resolutionLabel`, `shareOrDownload`, `ExportSheet`, capability/progress/export/still states |
| `ui/sheets/SoundbiteSheet.tsx` | source-range validation, audio-track insertion, encoded-file sharing/download |
| `ui/sheets/ClipSheets.tsx` | speed, volume, animation, filter previews, adjust, motion, mask, opacity, background removal, color, transition |
| `ui/sheets/TextSheets.tsx` | `presetStyle`, `PresetTiles`, `TextEditSheet`, `TextStyleSheet`, `StickerSheet` |

### Experimental

| File | Main exports and responsibilities |
| --- | --- |
| `experimental/types.ts` | `ExperimentalFeature` and build-neutral `Experimental` contract |
| `experimental/features.ts` | ordered feature list |
| `experimental/ExperimentalSheet.tsx` | `ExperimentalButton` and portal feature sheet |
| `experimental/index.ts` | experimental build implementation of the alias |
| `experimental/off.ts` | public/off build implementation of the alias |
