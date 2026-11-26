# ReelForge engine

The engine is the browser-side runtime that turns a project timeline into live
preview, encoded video, still images, captions, and standalone audio/video
clips. It deliberately keeps timeline semantics in `scene.ts`, GPU behavior in
`gl.ts`, and decode/mix/encode ownership in specialized modules so preview and
export share composition rules without sharing mutable timing state.

## Responsibilities and boundaries

| File | Responsibility |
| --- | --- |
| [`scene.ts`](../../src/engine/scene.ts) | Resolve timeline/project state at one time into compositor layers and editor hit quads. |
| [`gl.ts`](../../src/engine/gl.ts) | Upload textures and execute the WebGL layer, blur, and transition shaders. |
| [`preview.ts`](../../src/engine/preview.ts) | Drive the editor at animation-frame cadence, coordinate video slots, and attach previews/cutouts. |
| [`audio.ts`](../../src/engine/audio.ts) | Decode source audio, mix timeline windows, schedule live playback, and encode AAC/WAV support data. |
| [`export.ts`](../../src/engine/export.ts) | Render a stable project snapshot sequentially into MP4 or a single image. |
| [`captions.ts`](../../src/engine/captions.ts) | Prepare speech audio, coordinate ASR, normalize/group words, style captions, and export SRT. |
| [`captions.worker.ts`](../../src/engine/captions.worker.ts) | Own the Whisper pipeline, segment PCM, and post timed words. |
| [`background.ts`](../../src/engine/background.ts) | Main-thread matte cache/status/cancellation coordinator and RGBA source sampler. |
| [`background.worker.ts`](../../src/engine/background.worker.ts) | Own the quantized segmentation model and serialize image inference. |
| [`clip.ts`](../../src/engine/clip.ts) | Transcode trimmed/cropped clips, packet-mux separate downloads, and create poster frames. |
| [`soundbite.ts`](../../src/engine/soundbite.ts) | Validate suggested ranges and encode extracted audio as M4A or WAV. |
| [`sfx.ts`](../../src/engine/sfx.ts) | Procedurally build effects, render offline audio, and import them through the media library. |

## One frame: scene model to pixels

`scene.ts` does not issue WebGL work or read a clock, although its provider and
text cache may perform owned decoding/cache side effects. `buildFrame(project,
t, context)`:

1. Uses `activeMain` to select one active main item or two transition pages.
2. Resolves `restPose` and `itemPose` from keyframes, motion, and bounded
   entrance/exit animations.
3. Calls the supplied `FrameProvider` for synchronous frame lookup. A missing
   frame is represented by `null`; it does not block the scene builder.
4. Converts intrinsic dimensions, crop, fit, flip, masks, filters, chroma key,
   and optional subject matte into a `DrawLayer`.
5. Adds main pages first, then active overlays and text in lane order. Text is
   supplied by `TextCache`, whose appearance signature avoids repeated
   rasterization.
6. Returns `{ spec, quads }`. `spec` is GPU input; `quads` use frame-pixel
   geometry for editor hit tests. Selection quads use the stable rest pose
   during in/out animation.

`Compositor.render` then binds a reusable VAO and:

- renders each page to the canvas or to page framebuffers;
- creates an enlarged, low-resolution blurred background when a main item does
  not cover the frame;
- composites a transition in `TRANS_FS` when two pages are present;
- draws overlays/text after the transition; and
- periodically evicts long-unused textures.

`TexRef.version` is the invalidation contract. Preview video slots increment a
version whenever their canvas changes, `TextCache` increments one when a
signature changes, and export frame providers issue versions as they advance.
The compositor therefore avoids uploading unchanged browser objects.

## Editor preview path

The normal interactive control flow is:

```text
PreviewEngine.play()
  -> AudioPlayback.start(t)                   (master clock and audio pump)
  -> renderNow()
       -> maybeDraw(slots)                     (copy ready video to canvases)
       -> buildFrame(... provider ...)
            -> videoFrame(item, sourceTime)  (record wants / read warm frames)
            -> imageFrame(item)               (media cache lookup)
       -> Compositor.render(spec)
       -> syncSlots(project, t)               (seek/play/preroll/evict)
  -> requestAnimationFrame(loop)
```

`PreviewEngine.loop` takes time from `AudioPlayback.now()` while playing. Audio
is consequently not slaved to frame cadence, and picture seeking/drift
correction follows the audio anchor. Paused playback, editor seeking, and
`setPeek` use the stored/temporary project time instead.

Video slots are keyed by timeline item id but can adopt an idle slot with the
same media id, preserving a warm decoder across split points. Ordinary playback
uses hidden muted `<video>` elements. Unsupported or extreme playback conditions
step by seeking; `SinkFallback` uses `CanvasSink.getCanvas` for codecs the element
cannot present. Slot count is bounded normally, while active frames are never
destroyed merely to satisfy the nominal cap.

`AudioPlayback.pump` stays roughly 1.2 seconds ahead of the clock and schedules
0.5-second `AudioMixer` windows. A generation counter invalidates asynchronous
mix results after stop/edit/seek operations. Live nodes are stopped when
invalidated; preview-only one-shot nodes have a separate generation and can be
replaced without changing the timeline clock.

## Export and still-render path

`exportVideo` first clones the project so later store edits cannot alter an
in-progress encode. It then:

1. probes the preferred video and audio codecs;
2. preloads referenced media, images, and fonts;
3. acquires a best-effort wake lock;
4. creates a preserved drawing-buffer canvas, `Compositor`, `TextCache`,
   `OfflineFrames`, `AudioMixer`, and Mediabunny output/sources; and
5. advances every video frame at `i / fps`.

For each frame, the exporter mixes audio at least one second ahead, calls
`OfflineFrames.prepare`, and then calls `buildFrame` a second time with
everything synchronously ready. `OfflineFrames` records requested frames in the
first pass, decodes each source in increasing time (falling back from WebCodecs
to a video element), and attaches cutout mattes when required. `prepare` releases
decoders after their items finish; the final `finally` releases anything that
remains and cancels an unfinished Mediabunny output.

Progress reports `prepare`, `cutout`, `render`, and `finalize`. Render progress
reserves the last two percent for mux finalization; ETA begins only after a
useful number of frames. Cancellation is checked between frames/audio windows
and is passed into matte requests. Output remains an in-memory `BufferTarget`
until every track closes and `finalize` succeeds.

`renderStill` uses the same scene/preparation/compositor path at one clamped
project time, but it does not create an audio mixer, wake lock, progress
callback, or sequence encoder.

## Captions path

```text
transcribe(project, options)
  -> renderMix(project, 16000, 1)
  -> post CaptionRequest (transferred Float32Array)
  -> captions worker:
       load(model)
       -> segment(PCM) at 20 ms RMS boundaries
       -> ASR on sequential <=28 s regions
       -> result RawWord[]
  -> cleanWords
  -> groupWords / buildCaptions
  -> applyCaptionStyle and/or toSrt
```

The caption worker is cached for two idle minutes after a successful call.
Cancellation terminates it because the model invocation itself is not
interruptible. Download messages map to `CaptionProgress.phase = "download"`;
weighted non-silent segment progress maps to `"transcribe"`. Recognized network
and memory errors receive user-facing messages in `captions.ts`.

`cleanWords` discards bracketed non-speech chunks, attaches punctuation to the
previous token, divides multi-word chunks into token intervals, and repairs
non-monotonic/short timestamps. `buildCaptions` groups phrases, chooses one
collision-free lane against existing text, and stores caption-local word
offsets for highlight rendering.

## Background-removal path

When `readBackgroundRemoval(item).mode` is `"subject"`:

1. preview/export creates a `subjectMatteKey` from model version, media id, and
   a six-samples-per-second video-time bucket (stills use `null`);
2. preview may reuse a nearby cached matte; export requests the exact frame key;
3. `subjectMatte` downscales the browser source to at most 512 px, normalizes it
   to RGBA, and transfers its pixel buffer to `background.worker.ts`;
4. the worker lazily loads `Xenova/modnet`, runs requests serially in WASM, and
   returns channel 3 as a compact `Uint8Array`;
5. `background.ts` expands that alpha plane into an RGBA canvas, remembers it
   in a 12-entry LRU cache, and resolves the pending promise; and
6. `scene.ts` supplies the matte as `DrawLayer.cutout`, and the fragment shader
   smoothsteps alpha at the configured feather width.

The worker protocol distinguishes global model `load` messages from
request-scoped `progress`, `result`, and `error` messages. `onProgress` is
request-local while `getBackgroundStatus`/`subscribeBackgroundStatus` expose a
process-wide snapshot. Cancellation removes a main-thread correlation and
rejects it, but already-running worker inference may finish harmlessly. The
coordinator starts a two-minute termination timer after requests settle so
model memory is released when the worker is no longer useful.

## Audio ownership and mixing

`AudioMixer` is pull-based. It selects active, audible main/overlay video and
audio items, converts timeline overlap to source time using speed and in-point,
then applies volume, fades, and transition crossfades per destination sample.
It interpolates PCM for resampling and averages a wider box when downsampling
at high item speed. The result is hard-clipped to `[-1, 1]`.

`SinkReader` retains streaming audio chunks and serializes iterator advancement.
`WholeReader` is the fallback for files WebCodecs cannot decode and shares a
four-entry full-buffer cache. Reader instances are retained per timeline item
and garbage-collected after 40 unused mix calls. `renderMix` adds ten-second
production windows and always disposes its mixer.

Live `AudioPlayback` owns an `AudioContext`, master gain, scheduled timeline
nodes, and the optional one-shot preview node. Offline mixing/export owns no
live audio nodes. `canEncodeAac` registers the WASM encoder once if native AAC
is unavailable; `encodeWav` is a side-effect-free RIFF/PCM-16 serializer used
by procedural effects and soundbite fallback paths.

## Other file workflows

- `encodeClip` trims and transcodes video or audio, applying video crop and
  available video/audio codecs (or WAV audio fallback). `muxStreams` instead
  copies encoded packet sources from picture-only and sound-only downloads
  without re-encoding.
- `encodeSoundbite` creates a one-track project around an extracted audio item,
  so it can reuse `AudioMixer` and preserve normal source-time behavior.
- `renderSfx` schedules a definition into an `OfflineAudioContext`; `importSfx`
  persists a generated WAV once per id for the current session.
- `posterFrame` owns a temporary object URL/video/canvas and returns a 320 px
  JPEG, or `null` after warning on failure.

## Resource ownership and cleanup

| Resource | Owner | Release point |
| --- | --- | --- |
| Preview hidden video/slots | `PreviewEngine` | `destroySlot` / `dispose` |
| Live audio nodes/context | `AudioPlayback` | stop/preview replacement/dispose |
| Streaming PCM decoders | `AudioMixer` readers | GC or mixer disposal |
| Exact export decoders | `OfflineFrames`/`SeqSource` | finished item or export `finally` |
| Text canvases | `TextCache` | stale sweep or engine disposal |
| WebGL textures/FBOs/context | `Compositor` | reference release, GC, or `dispose` |
| Cutout/ASR workers and models | respective main-thread coordinators | idle timeout, abort, or fatal worker error |
| Mediabunny encoders/outputs | clip/soundbite/export function | Finalization; input/listener cleanup; output cancellation where the API owns a partial stream |
| Temporary poster URL/video/canvas | `posterFrame` in `clip.ts` | function `finally` / element unload |

Failures in a single source read are generally logged and skipped so the rest
of a mix/preview continues. Export, transcription, soundbite, and clip jobs
instead reject their public operation; owned resources are released by the
relevant `finally` blocks and cleanup paths. Worker failures cross a typed
`error` message, are converted to friendly errors where applicable, and reach
the caller through progress/error state or a rejected promise.

## Navigable API index

### Scene and compositor

- [`scene.ts`](../../src/engine/scene.ts): `FrameSource`, `FrameProvider`,
  `SceneContext`, `HitQuad`, `Pose`, `restPose`, `itemPose`, `TextCache`,
  `buildFrame`, `hitTest`
- [`gl.ts`](../../src/engine/gl.ts): `TexRef`, `DrawLayer`, `Page`,
  `FrameSpec`, `TRANSITION_CODES`, `Compositor` (`render`,
  `releaseTexture`, `dispose`)

### Timeline media and export

- [`preview.ts`](../../src/engine/preview.ts): `PreviewOptions`,
  `PreviewEngine` (`setViewport`, `projectChanged`, `seek`, `setPeek`, `play`,
  `pause`, `toggle`, `requestRender`, `renderNow`, `dispose`)
- [`audio.ts`](../../src/engine/audio.ts): `MixOptions`, `AudioMixer`
  (`mix`, `dispose`), `renderMix`, `AudioPlayback` (`setMuted`, `now`, `start`,
  `stop`, `invalidate`, `preview`, `stopPreview`, `dispose`), `canEncodeAac`,
  `encodeWav`
- [`export.ts`](../../src/engine/export.ts): `ExportResolution`,
  `ExportQuality`, `ExportSettings`, `ExportProgress`, `ExportResult`,
  `exportDims`, `videoBitrate`, `estimateSize`, `canExport`, `exportVideo`,
  `renderStill`

### Captions and background

- [`captions.ts`](../../src/engine/captions.ts): `CAPTION_MODELS`,
  `CAPTION_LANGUAGES`, `CaptionOptions`, `DEFAULT_CAPTION_OPTIONS`,
  `CaptionProgress`, `TimedWord`, `transcribe`, `cleanWords`, `groupWords`,
  `captionStyle`, `buildCaptions`, `applyCaptionStyle`, `toSrt`
- [`captions.worker.ts`](../../src/engine/captions.worker.ts): `CaptionModel`,
  `RawWord`, `CaptionRequest`, `CaptionWorkerMessage`
- [`background.ts`](../../src/engine/background.ts): `BACKGROUND_MODEL`,
  `BACKGROUND_MODEL_VERSION`, `SUBJECT_SAMPLE_RATE`, `SubjectMatte`,
  `BackgroundStatus`, `getBackgroundStatus`, `subscribeBackgroundStatus`,
  `subjectMatteKey`, `peekSubjectMatte`, `peekRecentSubjectMatte`,
  `subjectMatteBusy`, `subjectMatte`
- [`background.worker.ts`](../../src/engine/background.worker.ts):
  `BackgroundRequest`, `BackgroundWorkerMessage`

### Standalone media utilities

- [`clip.ts`](../../src/engine/clip.ts): `ClipJob`, `ClipResult`, `ClipError`,
  `encodeClip`, `muxStreams`, `posterFrame`
- [`soundbite.ts`](../../src/engine/soundbite.ts): `SoundbiteCheck`,
  `checkSoundbite`, `tidyTime`, `suggestSoundbite`, `NoSoundError`,
  `encodeSoundbite`
- [`sfx.ts`](../../src/engine/sfx.ts): `SFX`, `renderSfx`, `importSfx`
