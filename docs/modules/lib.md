# `src/lib`: shared runtime services

## Scope and boundaries

`src/lib` connects serializable editor data to browser storage, media codecs, Android
capabilities, network adapters and pure timeline/display helpers. Files in this
directory do not own a React screen or the compositor itself. Most APIs either:

- transform plain project data without I/O;
- read/write origin-local IndexedDB and browser preferences;
- load or derive media locally; or
- provide a browser/Capacitor boundary for a device operation.

The APIs are consumed by `src/state`, `src/ui` and `src/engine`. Their source-level
JSDoc/TSDoc explains each exported contract and substantial helper; this guide
describes how those contracts cooperate.

## Subsystem map

| Subsystem | Files | Primary responsibility |
| --- | --- | --- |
| Timeline domain helpers | `defaults.ts`, `layout.ts`, `clip.ts` | Construct projects/items and apply timing, lane, trim, split, crop and clip-range rules |
| Persistence | `db.ts`, `backup.ts`, `backupStore.ts`, `backupReminder.ts`, `build.ts` | IndexedDB schema, backup container, merge restore, live preference adapter and update reminders |
| Media | `media.ts`, `library.ts` | Probe/import bytes, cache decoded resources, generate thumbnails/waveforms, capture frames and expose saved clips as project assets |
| Text/appearance | `text.ts`, `filters.ts`, `color.ts`, `background.ts` | Shared typography rasterization, presets/effects, WCAG color math and background-removal migration |
| Device/browser glue | `device.ts`, `native.ts`, `haptics.ts`, `back.ts` | File/share/filesystem, keyboard and wake-lock behavior, Capacitor networking, tactile feedback and modal history |
| External media adapters | `social.ts`, `youtube.ts`, `route.ts` | Parse/extract public posts and YouTube results, download on Android, and expose hash routes |
| General utilities | `util.ts` | IDs, math/easing, clocks, formatting, platform detection, local saves and safe names |

## File and public-API index

### Project construction and timeline behavior

- **`defaults.ts`** — `DEFAULT_ADJUST`, `DEFAULT_TEXT_STYLE`, `defaultVisual`,
  `newProject`, `videoItem`, `imageItem`, `colorItem`, `textItem`,
  `audioItem`, `aspectFor`. Factories create independent nested objects and
  stable client IDs; they do not persist the project.
- **`layout.ts`** — `MIN_DUR`, `FREE_TRACKS`, `ALL_TRACKS`, `itemEnd`,
  `clonePlain`, `canvasSize`, `transitionOverlap`, `layoutMain`,
  `compactLanes`, `normalize`, `mainEnd`, `projectDuration`, `allItems`,
  `findItem`, `maxDuration`, `sourceTime`, `laneFree`, `pickLane`, `laneCount`,
  `ActiveMain`/`activeMain`, `mainIndexAt`, `mainInsertIndex`, `snapPoints`,
  `KeyValues`/`sampleKeyframes`, `splitItem`, `deleteItem`, `duplicateItem`,
  `moveMainItem`, `moveFreeItem`, `applyTrim`, `setSpeed`, `upsertKeyframe`.
  Editing functions mutate the supplied project, then normalize it.
- **`clip.ts`** — `MIN_CLIP`, `RangeCheck`/`checkClipRange`,
  `CropRect`/`CropAspect`, `FULL_CROP`, `CROP_ASPECTS`, `aspectRatio`,
  `cropForAspect`, `moveCrop`, `resizeCrop`, `isFullCrop`, `cropPixels`,
  `parseYouTubeId`, `parseYouTubeStart`, `isDirectMediaUrl`, `KindFilter`,
  `FolderFilter`, `filterClips`, `uniqueName`, `clipSourceRange`, `timeStamp`.
  All operations are pure; network and encoding happen elsewhere.

### Local persistence and portable backups

- **`db.ts`** — `db`, `listProjects`, `getProject`, `saveProject`,
  `deleteProject`, `putMedia`, `getMedia`, `hasMedia`, `getThumbs`,
  `putThumbs`, `getPeaks`, `putPeaks`, `listClips`, `listClipIds`, `getClip`,
  `putClip`, `updateClipMeta`, `deleteClip`, `listFolders`, `putFolder`,
  `deleteFolder`, `projectMediaIds`, `gcMedia`, `storageInfo`,
  `requestPersistence`, plus `ThumbRecord`, `PeakRecord` and `ClipRecord`.
- **`backupStore.ts`** — `appStore`, the production `BackupStore` bridge from
  abstract backup operations to IndexedDB and localStorage, with immediate
  application of restored theme/look preferences.
- **`backup.ts`** — `BACKUP_EXTENSION`, `BACKUP_MIME`, `SETTING_KEYS`,
  `BlobRef`, `BackupIndex`, `BackupStore`, `BackupSink`, `BlobSink`,
  `BackupProblem`/`BackupError`, `backupFileName`, `BackupOptions`,
  `BackupSummary`, `BackupEstimate`, `estimateBackup`, `writeBackup`,
  `OpenedBackup`, `openBackup`, `RestoreOptions`/`RestoreSummary`,
  `restoreBackup`.
- **`backupReminder.ts`** — `LAST_BUILD_KEY`, `LAST_BACKUP_KEY`,
  `RECENT_BACKUP_MS`, `ReminderInput`/`ReminderEnv`, `shouldRemind`,
  `readLastBackup`, `markBackedUp`, `checkReminder`,
  `reminderForThisLaunch`, `answerReminder`.
- **`build.ts`** — build-time `BUILD_ID`, falling back to `dev` for local and
  unbuilt environments.

### Media and saved clips

- **`media.ts`** — `mediaEvents`, `registerAsset`,
  `getAsset`, `loadAssets`, `getBlob`, `getObjectUrl`, `peekObjectUrl`;
  `kindOf`, `probe`, `importFiles`, `makeCanvas`, `canvasToBlob`,
  `loadVideoElement`, `seekElement`;
  `getImage`/`peekImage`; `ThumbStrip`, `getThumbStrip`, `ensureThumbs`;
  `PEAK_RATE`, `getPeaksSync`, `ensurePeaks`, `decodeWholeAudio`,
  `captureFrame`.
- **`library.ts`** — `clipFile`, `clipAssetId`, `importClip`. A saved clip is
  converted to a `File`, probed once if needed, and registered with the stable
  project-media ID `m_<clip id>`.

### Rendering support

- **`text.ts`** — `FONTS`, `closestWeight`, `fontCss`, `fontEvents`,
  `ensureFont`, `isFontReady`, `TEXT_PRESETS`, `CAPTION_PRESETS`,
  `TextRenderOpts`,
  `renderTextCanvas`, `textCharCount`.
- **`filters.ts`** — `FxParams`, `ADJUST_KEYS`, `ADJUST_DEFS`, `FilterDef`,
  `FILTERS`, `computeFx`. A `null` result tells the renderer that no effect
  pass is needed.
- **`color.ts`** — `RGB`, `HSL`, `parseHex`, `toRgb`, `toHex`, `toHsl`,
  `fromHsl`, `luminance`, `ratio`, `contrast`, `nearestLightness`. These
  routines are pure and use WCAG sRGB luminance.
- **`background.ts`** — `DEFAULT_BACKGROUND_REMOVAL`, `isBackgroundRemoval`,
  `normalizeBackgroundRemoval`, `readBackgroundRemoval`,
  `writeBackgroundRemoval`, `hasBackgroundRemoval`. It keeps modern
  `backgroundRemoval` and legacy `chroma` representations in sync.

### Platform, routing and external services

- **`back.ts`** — `pushBack`, `useBack`, `backDepth`, `settled`; maintains a
  stack over browser history so the top sheet consumes Android/iOS back.
- **`device.ts`** — `trackKeyboard`, `primeKeyboard`, `pickFiles`,
  `shareFile`, `canEncodeVideo`, `acquireWakeLock`.
- **`native.ts`** — `isNative`, `nativeSystemBars`, `nativeFetch`, `anyFetch`,
  `nativeNet`, `WriteOptions`, `nativeShare`, `nativeSave`.
- **`haptics.ts`** — `haptic`, using Vibration on Android and a hidden native
  switch compatibility path on iOS.
- **`route.ts`** — `Route`, `useRoute`, `openProject`, `openStudio`, `goHome`.
  Routing is hash based and uses `useSyncExternalStore`.
- **`youtube.ts`** — `YtVideo`, `YouTubeError`, `canUseYouTubeApi`,
  `searchYouTube`, `DownloadOptions`, `Downloaded`, `downloadYouTube`,
  `youTubeDetails`.
- **`social.ts`** — `SocialSite`, `SITE_NAMES`, `SocialLink`, `SocialError`,
  `parseSocialLink`, `tikTokId`, `instagramShortcode`, `instagramMediaId`,
  `HttpRequest`, `HttpTextResponse`, `SocialNet`, `cookieFrom`, `SocialPost`,
  `parseTikTokPage`, `InstagramPageInfo`, `parseInstagramPage`,
  `parseInstagramMedia`, `SocialDownloadOptions`, `SocialDownload`,
  `downloadSocial`.
- **`util.ts`** — `uid`, `clamp`, `lerp`, `easeInOut`, `easeOut`, `backOut`,
  `formatTime`, `formatClock`, `parseTime`, `formatDuration`, `formatBytes`,
  `ago`, `hexToRgb`, `rgba`, `debounce`, `isIOS`, `isAndroid`,
  `isStandalone`, `nextFrame`, `sleep`, `even`, `deepClone`, `isNativeApp`,
  `downloadBlob`, `safeFileName`.

## Main data flows

### Import to timeline

```text
device picker / direct URL / native download
        |
        v
probe local bytes -> MediaAsset metadata
        |
        +----> db.putMedia(asset, blob)
        +----> media.registerAsset(asset, blob)
        +----> default item factory -> project item with mediaId
        `----> background ensureThumbs / ensurePeaks
```

`MediaAsset` remains small and serializable. Project items store its `id`, not
the blob. `loadAssets` and `getBlob` hydrate missing records from IndexedDB, and
object URLs plus decoded resources are session caches rather than durable
records.

### Editing to save

```text
UI gesture/action
    -> layout mutation (split, trim, lane, keyframe, speed)
    -> normalize(project)
    -> preview/export consume the normalized snapshot
    -> state layer debounces saveProject(project)
```

Main track items remain lane zero and are laid out sequentially; the incoming
clip's transition may overlap the outgoing clip, capped at half of each
duration. Free tracks allow independent starts, but lane selection avoids
overlap. Every split/duplicate/move/trim/speed operation ends by enforcing
these invariants.

### Media decode and derived caches

- `probe` first asks Mediabunny for tracks, duration, dimensions and WebCodecs
  capability. Timed media falls back to a browser media element; unsupported
  content rejects with an import-facing error.
- Derived decoding runs through one `enqueue` tail so thumbnail/waveform jobs do
  not compete for phone resources.
- Thumbnails are 96 px JPEG cover crops, sampled up to roughly 120 frames based
  on duration. WebCodecs `CanvasSink` is preferred; seeking a `<video>` is the
  compatibility fallback.
- Waveforms contain 50 normalized byte peaks per second. WebCodecs streaming
  decode is preferred; `decodeWholeAudio` uses `OfflineAudioContext` as a
  memory-heavier fallback.
- `captureFrame` first requests the timestamp through WebCodecs, then falls
  back to video-element seeking and a full-resolution canvas.
- Completion dispatches `mediaEvents` with the asset ID. Cache-generation
  failures are warnings rather than fatal media-import errors.

## IndexedDB schema and retention

The database is named `reelforge`, currently schema version 2.

| Store | Key | Value | Purpose |
| --- | --- | --- | --- |
| `projects` | `id` key path | `Project` | Complete serializable editor documents |
| `media` | out-of-line asset ID | `{ asset, blob }` | Original source bytes and probe metadata |
| `thumbs` | `id` key path | `ThumbRecord` | Derived JPEG strips and spacing |
| `peaks` | `id` key path | `PeakRecord` | Derived normalized waveform bytes |
| `clips` | `meta.id` key path | `ClipRecord` | Saved library file, metadata and optional poster |
| `folders` | `id` key path | `ClipFolder` | Clip-library organization |

Version 1 created projects/media/derived stores. Version 2 added clips and
folders without removing existing records. `listClips` uses a cursor and
returns metadata/posters only, avoiding transfer of clip source blobs.

Deleting a project runs `gcMedia`. It scans all remaining saved projects through
`projectMediaIds`; media IDs that no project references (except explicit
temporary `keep` IDs) lose their `media`, `thumbs` and `peaks` records together.
Deleting a folder is different: in one transaction it removes the folder and
sets affected clip `folderId` values to `null`, so clips remain in the library.

Storage estimates and persistence permission are browser-owned and therefore
best-effort. Unsupported APIs or denied requests resolve to zero/false without
breaking the editor.

## Backup container and restore semantics

An `.rfbackup` is a versioned, single-pass binary container:

```text
"RFBACKUP" | u32 format (little endian)
| referenced media/clip/poster blobs
| UTF-8 JSON index
| u32 index length | "RFBACKUP"
```

The index contains build/time metadata, settings, folders, projects, media
descriptors and clips. Blob descriptors carry offsets, lengths and MIME hints.
The terminal marker allows a stopped/native write or truncated copy to be
identified as `incomplete`.

Important write behavior:

- `estimateBackup` and `writeBackup` first settle the same data snapshot.
- A full backup copies only source media referenced by saved projects, but
  copies the complete clip library. A projects-only backup copies no binary
  data.
- Allow-listed settings are `rf-theme`, `rf-look`, `rf-text-style`,
  `rf-studio`, `rf-export` and `rf-captions`; unrelated localStorage is not
  copied.
- `BlobSink` retains pieces for an in-memory blob. Android writes can instead
  consume an incremental sink so progress and cancellation are available.
- Offset sizes and the closing marker are validated before restore reads any
  file slice.

`openBackup` classifies errors as `not-backup`, `incomplete`, `newer` or
`damaged`. Invalid optional entries may be dropped and counted rather than
preventing valid projects/files from being restored. Schema-critical index
data and blob ranges must pass validation.

Restore is a safe merge:

1. detect existing folders, clips and media;
2. write missing folders first;
3. add missing source files and clips;
4. save an absent project, or update a same-ID project only when the backup copy
   is newer and all media it references are present;
5. restore settings only when the local setting is absent.

Therefore repeated restoration is idempotent for existing binary records, does
not replace unrelated local data, and can be resumed after cancellation. A
projects-only backup may add a project that references unavailable bytes;
the summary records it as `incomplete`. Backup files are not encrypted and
contain the selected source/project data, so their filesystem/share destination
should be treated as sensitive.

## Native, network and external adapters

`native.ts` is the sole Capacitor bridge in this subsystem.

- `nativeFetch` translates a `Request` into `CapacitorHttp`, reproduces the
  response as a standards `Response`, honors abort checks around the native
  request and handles Capacitor's inconsistent base64/text/JSON return forms.
  It is used for external download requests, not for ReelForge persistence.
- `nativeNet` supplies text and binary requests for `social.ts`; the Android
  cookie manager retains cookies between calls so the public-site pages behave
  like a browser session.
- Filesystem writes use 3 MiB chunks. Cancellation/error removes a partial
  native file. Sharing writes to cache and the next share removes cache copies
  older than 24 hours; retention avoids racing a receiving app that still reads
  the shared URI. `nativeSave` writes under `Documents/ReelForge`.
- `SystemBars`, share and filesystem imports are dynamic so browser builds do
  not initialize native-only packages.

YouTube search/download is intentionally Android-only because browser CORS
blocks the needed requests. `innertube` caches a session and retries session
creation after failure. Signature code returned by the YouTube player runs in
a zero-size iframe with `sandbox="allow-scripts"`: it has no same-origin
permission to inspect ReelForge storage, DOM state or pages. Client formats
are tried in compatibility order, and prefix/suffix probes reject streams that
allow only an initial fragment. Cancellation propagates as `AbortError`.

`social.ts` supports public TikTok/Instagram posts only. It removes tracking
parameters where safe, follows short/share pages, extracts site-provided video
URLs, retries ranged byte requests and tries alternate URL candidates. There
is no ReelForge proxy and no explicit sign-in flow. Site pages may change;
schema/rate-limit/login/private/deleted cases become `SocialError` messages,
while unexpected formats remain errors at the caller boundary.

## Browser behavior, routing and UI helpers

`route.ts` stores route snapshots in a tiny external store. `openProject` and
`openStudio` append hash entries and mark them as eligible for a one-step
history return; routes opened directly fall back to hash replacement.

`back.ts` layers modal entries onto browser history independently of route
hashes. It ignores `popstate` events caused by its own programmatic rewinds and
queues new pushes until those asynchronous events settle. `useBack` rearms an
entry if the close callback returns `false`.

`device.ts` adapts viewport keyboard height to CSS, primes iOS keyboard focus
inside the original tap, exposes hidden file input results and chooses
native/Web Share where available. Wake locks and haptics are best-effort.
`downloadBlob` never uploads data: it uses a Documents write in Capacitor or an
ephemeral browser download object URL that is revoked after one minute.

## Text, filters, backgrounds and privacy/failure invariants

`renderTextCanvas` is the shared text rasterizer for preview/export. It:

1. measures normalized paragraph/token layout;
2. wraps to a caller-supplied pixel width;
3. computes backgrounds, stroke/shadow padding and canvas dimensions;
4. downsizes over-4096 px textures and returns the upscale factor;
5. draws word highlighting and a character-reveal budget;
6. clears or preserves the canvas consistently for re-use.

Font loading is deduplicated and failures intentionally fall through to CSS
fallback fonts. `fontEvents` asks renderers to retry after an attempt.

`computeFx` multiplies preset parameters by `filterAmount` and adds manual
adjustments. `background.ts` validates untrusted persisted settings, clamps
renderer ranges and translates older chroma-only projects without mutating
them on read. `writeBackgroundRemoval` makes modern and legacy persisted shapes
consistent.

Across the subsystem:

- pure utility failures are represented by `null`, `false`, a typed error or a
  clamped fallback rather than silently changing the public input contract;
- file imports and derived-cache jobs isolate per-file failures;
- cancellation points use `DOMException(..., 'AbortError')`;
- blocked localStorage, unavailable storage persistence, denied wake locks,
  missing haptics and unavailable fonts do not prevent core editing;
- project/media/backup contents stay on the local origin unless the user opens
  an external URL or explicitly downloads/shares the result. Android social
  and YouTube adapters send only the network requests needed for that selected
  public source and rely on the platform cookie jar rather than a ReelForge
  service.
