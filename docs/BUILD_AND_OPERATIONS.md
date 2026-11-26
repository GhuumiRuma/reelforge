# Build and operations

## Build modes

`vite.config.ts` produces two deployment shapes and two feature sets.

| Command | Web base | Feature adapter | Destination |
| --- | --- | --- | --- |
| `npm run dev` / `npm run build` | `/reelforge/` | `src/experimental/off.ts` | local Vite or GitHub Pages |
| `npm run dev:experimental` | `/reelforge/` | `src/experimental/index.ts` | local testing |
| `npm run build:android` | `/` | `src/experimental/off.ts` | Capacitor `dist` -> Android |
| `npm run build:android:experimental` | `/` | `src/experimental/index.ts` | Capacitor `dist` -> experimental Android build |

The `@experimental` alias is the only stable application entry into unreleased
code. For ordinary production builds the `rf-experimental-only` plugin fails if
any other file from `src/experimental/` reaches Vite's module graph. This prevents
an indirect import from bypassing the empty adapter.

`rf-legal-files` emits the repository's license and third-party notices into every
bundle. The PWA's navigation fallback explicitly excludes those files, so they open
as plain legal documents instead of being rewritten to `index.html`.

## PWA

`vite-plugin-pwa` generates the manifest and Workbox service worker:

- the app shell, CSS, JavaScript and a bounded set of font files are precached;
- captions/background workers and large WebAssembly/model payloads are excluded
  from the eager cache;
- workers and fonts gain runtime `CacheFirst` entries when used;
- `registerType: 'prompt'` keeps a waiting update under user control; and
- browser builds poll an installed worker registration hourly.

Capacitor builds intentionally skip service-worker registration. Their web files
are packaged into the APK and updated with the APK itself.

## TypeScript

`tsconfig.json` uses strict TypeScript with `noEmit`. It targets ES2022 and checks
both `src` and the Vite configuration. The path mapping for `@experimental` points
at the full typed API during type-checking; Vite swaps the runtime implementation
to `off.ts` for stable builds. The compile-time contract therefore stays identical
for both adapters.

## Capacitor and Android

`capacitor.config.ts` fixes the Android WebView origin at
`https://localhost`. IndexedDB storage is origin-scoped, so this value is a
backward-compatibility guarantee rather than a cosmetic URL choice.

The Capacitor sync step copies `dist` into Android assets and updates generated
plugin configuration. `android/app/src/main/.../MainActivity.java` is a thin
`BridgeActivity`; React remains the only UI implementation.

`android/app/build.gradle` creates:

- `release`: the public ReelForge package; and
- `experimental`: the same native shell with an
  `.experimental` application ID suffix, name override and version suffix.

Both build types start from one WebView and signing setup, but different package
IDs create independent installations and storage origins/data spaces.

Permissions are constrained to Internet, voice recording/audio configuration and
legacy storage access only through Android 9. FileProvider grants temporary access
to files selected for native sharing; it is not publicly exported.

## Stable Android workflow

`.github/workflows/android.yml` runs for pushes and manual dispatches:

1. install Node 24, Java 21 and npm dependencies;
2. run the tests and Android web build;
3. assemble the release APK;
4. inspect the finished APK's signer with `apksigner`;
5. upload the APK as a workflow artifact; and
6. on `main`, replace the `android-latest` release.

APK version code/name come from the Actions run number. Public releases require the
permanent signing key because Android's package updater accepts only the same
certificate. A fingerprint check reads the final package instead of trusting the
input keystore. Forks can create a one-off key for testing, but that APK cannot
update an installed ReelForge copy.

When `android-latest` is replaced, the workflow carries its previous counted
downloads into an invisible `rf-banked-downloads` release-note marker. That marker
and the live asset count together preserve the cumulative statistic.

## Experimental Android workflow

`.github/workflows/experimental.yml` is private-by-construction around release
distribution:

- the source and build workflow are public, but the APK is not an artifact or
  GitHub release;
- signing, package ID and certificate are checked before upload;
- the APK is uploaded to a private Azure Blob container through OIDC; and
- its JSON metadata is written only after the APK upload.

If signing or Azure settings are absent, the workflow deliberately reports a
warning and skips the corresponding stage. The separate app package prevents
experimental data and updates from replacing the stable application.

## GitHub Pages workflow

`.github/workflows/deploy.yml` runs the tests and normal production build on
`main`, uploads `dist` as a Pages artifact, then deploys that artifact through the
`github-pages` environment. Build and deploy are separate jobs so the deployment
environment receives only a validated package.

## Download statistics

`scripts/download-stats.mjs` is a dependency-free command-line module used by
`.github/workflows/download-stats.yml` and by `npm run downloads`.

The ledger on the separate `download-stats` branch stores:

- raw and adjusted running totals;
- UTC snapshot timestamps;
- release-replacement adjustments; and
- a monotonically non-decreasing series.

Each daily workflow snapshots GitHub's release assets. A drop can occur while a
release is being replaced, so `recordSnapshot` adds the lost count to an offset and
records the adjustment. Daily and weekly reports derive from interpolation between
those snapshots, while the Android workflow's release-note marker prevents normal
replacement drops from occurring.

The workflow serializes access with one concurrency group, writes a separate stats
worktree, and posts only the first missing weekly issue. Keeping data on another
branch prevents generated reports from triggering the application build.

## Icon generation

`node scripts/icons.mjs` generates PWA PNGs, the SVG favicon and Android launcher
icons from one signed-distance shape renderer. It writes binary PNG chunks directly
with Node's zlib module, so no image design dependency is required.

## Operational invariants

Do not change these independently:

- Android application ID, package signing certificate and release fingerprint;
- Capacitor WebView origin and existing on-device storage;
- stable/experimental build aliases and the experimental-only load guard;
- PWA base, manifest scope/start URL and deployed Pages path;
- `rf-banked-downloads` format and the stats ledger schema;
- license/notices emission and service-worker denylist.

Changes to one member of an invariant require explicit migration or coordinated
workflow, signing and deployment updates.
