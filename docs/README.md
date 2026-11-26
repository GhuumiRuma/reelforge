# ReelForge technical documentation

Start with [`ARCHITECTURE.md`](ARCHITECTURE.md) for the application-wide picture,
then use the subsystem guides for file-by-file and method-level explanations:

| Guide | Covers |
| --- | --- |
| [UI and state](modules/ui-state.md) | Screens, controls, routing, editor history, sheets, selection, timeline gestures, appearance and experimental features |
| [Engine](modules/engine.md) | Preview, scene compositing, WebGL, audio, export, captions, cutouts and workers |
| [Libraries and platform adapters](modules/lib.md) | Persistence, backups, media import, layout, native bridges, networking, clip library and shared utilities |
| [Build and operations](BUILD_AND_OPERATIONS.md) | Vite/PWA, Android/Capacitor, signing, releases, experimental distribution and download statistics |

Method documentation lives next to the implementation as JSDoc/TSDoc. The guides
explain how those methods cooperate; they are not a replacement for the source-level
contracts. Tests remain the executable specification for edge cases and compatibility.

## Reading paths

- **Follow an edit:** `Home` or `Studio` -> route/editor setup -> `useEditor` ->
  action sheet or timeline handler -> normalized `Project` -> autosave, preview and
  eventual export.
- **Follow a frame:** playhead timeline time -> selected scene items -> media/video
  decode -> `engine/scene` composition -> WebGL effects -> preview canvas.
- **Follow a binary file:** import picker/link/native download -> media metadata and
  blob storage -> `MediaAsset` reference on `IndexedDB` -> a project item that stores
  only the asset ID.
- **Follow a release:** Vite build -> PWA assets or Capacitor `dist` -> Android
  Gradle package -> signed APK check -> release or private experimental upload.

