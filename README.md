# ReelForge

A full video editor for content creators that runs on your phone. Edit, caption and export without an account, uploads, watermark or subscription. Everything, including speech-to-text and video encoding, happens on the device.

**Open it:** https://ghuumiruma.github.io/reelforge/

## Install it on your phone

- **Android app (Samsung and other Android phones):** on the phone, open the [Latest Android app release](https://github.com/GhuumiRuma/reelforge/releases/tag/android-latest) and tap **ReelForge.apk**. Open the downloaded file and tap **Install**. The first time, Android asks you to allow installs from your browser (on Samsung: **Settings → Apps → Special access → Install unknown apps**). New versions install right over the old one and keep your projects and clips, so don't uninstall first (see [Updating the Android app](#updating-the-android-app)). Only the Android app can search and download from YouTube, or download from TikTok and Instagram.
- **iPhone:** open the link in Safari, tap **Share**, then **Add to Home Screen**.
- **Android, desktop or any browser:** open the link in Chrome, tap the **⋮** menu, then **Install app** (or **Add to Home screen**).

After the first visit it works offline. Auto-captions download a speech model (about 65 MB) the first time you use them.

## Updating the Android app

Install the new **ReelForge.apk** right over the app you already have. Android shows **Update**, and your projects, clips and settings stay. **Don't uninstall first**: that deletes everything the app has stored. After an update, the app offers to [back up your work](#back-up-and-restore).

If Android says **App not installed** because the app **conflicts with an existing package**, your copy of ReelForge comes from one of the first builds. Each of those was signed with a different key, so Android can't see the new app as an update of it, and they have no backup button. Save your finished videos to your camera roll, uninstall once (that deletes the projects stored in the app), then install the new version. Every build from here on installs over the one before it.

## What you can do

- **Clips:** import videos, photos and audio, then trim, split, duplicate, reorder, replace, rotate, flip, freeze a frame, extract the audio and make soundbites. Save any piece of a clip to **My clips** and reuse it in this or any other project.
- **Speed:** 0.1× to 10×, with pitch that follows the speed.
- **Canvas:** 9:16, 16:9, 1:1, 4:5, 3:4, 4:3 and 21:9; fit or fill; a blurred or solid color background.
- **Text and stickers:** styled text presets, 12 fonts, outline, shadow, background, emoji stickers, and in and out animations.
- **Auto-captions:** word-timed captions with karaoke-style highlighting, generated on the device, with SRT export.
- **Audio:** music, voiceover recording, built-in sound effects, volume, fades and mute.
- **Look:** 20 filters, 12 adjustments (brightness, contrast, saturation, warmth and more), crop, masks, blend modes, opacity and green screen.
- **Motion:** 17 transitions, Ken Burns zoom and pan, and keyframes for position, scale, rotation and opacity.
- **Layers:** picture-in-picture overlays, text and audio tracks.
- **Export:** MP4 at up to 4K and 60 fps with a size estimate, then share straight to TikTok, Instagram or YouTube. You can also save a single frame as a thumbnail.
- **Safety net:** unlimited undo and redo, and autosave of every project to the device.
- **Light or dark:** the app follows your phone's setting. To pick one yourself, tap the **Appearance** button at the top of the home screen and choose **Light**, **Dark** or **System default**.

## Clip studio

Tap **Clip studio** on the home screen to watch, search and clip on one screen.

1. **Find a video.** In the Android app, type in the search box to search YouTube, or paste a YouTube, TikTok or Instagram link. TikTok and Instagram videos download straight away (public posts only; for an Instagram carousel, the link's `img_index` picks the item, otherwise its first video). In any browser you can paste a YouTube link to watch it, paste a direct link to a video or audio file, or tap the folder button to open a file from your device.
2. **Mark the clip.** Play the video and tap **Now** to set the start and end, or type the times. Tap **Play the clip** to check it.
3. **Choose video or audio,** and pick a crop shape (9:16, 1:1, 4:5, 16:9 or free). Drag the box to move it; drag its corner to resize it.
4. **YouTube videos** download first (Android app only): pick 360p, 720p or 1080p and tap **Download to crop and clip**. Your start and end stay marked.
5. **Name it, pick a folder and tap Save.** Video clips are saved as MP4 and audio clips as .m4a (or .wav).

Saved clips appear under **Clips** on the home screen. There you can make folders, filter by video or audio, search, play, share, save to the device (Documents/ReelForge in the Android app), rename, move, delete, or open a clip in a new editing project. While you edit, the same clips are in **My clips** (see below).

Only download and clip videos you own or have permission to use, and follow the Terms of Service of YouTube, TikTok and Instagram. These sites change how they serve videos from time to time, so searches or downloads may stop working until the app is updated.

## Make a soundbite

1. Tap a video clip on the timeline, then tap **Soundbite**.
2. Type where the soundbite starts and ends, counted from the beginning of the clip's original video. `42.5` is 42.5 seconds and `102.5` is 1:02.5, so you don't need a colon (`1:02.5` works too).
3. Tap **Add to audio track** to place it at the playhead, or **Save audio file** to share or download it as an .m4a file (or .wav if the device can't make .m4a files).

The clip keeps its own sound, so move the soundbite or mute the clip if you hear both at once.

## Chop up clips and reuse the pieces

1. **Split.** Move the playhead to where you want the cut and tap **Split** (the scissors), or press `S`. With nothing selected it cuts the main-track clip under the playhead; select an overlay or audio clip first to cut that one. Drag a clip's edges to trim it. Touch and hold a clip for a moment, then drag it to move or reorder it.
2. **Save a piece.** Select a video or audio clip and tap **Save clip**. Name it and tap **Save**. It is saved between the clip's edges, so split and trim first to get just the bit you want.
3. **Reuse it.** Tap **Media** or **Overlay** for video bits, or **Audio** for audio bits, then pick one under **My clips**. On the main track a video bit goes in at the clip edge nearest the playhead; as an overlay it goes in at the playhead. Audio bits go on the audio track at the playhead.

Saved pieces are the same clips as under **Clips** on the home screen, so you can use them in any project. A saved piece is the original footage between the clip's edges. Speed, filters, volume and other changes you made to the clip are not included, and the toast tells you when speed was left out.

## Back up and restore

Tap **Back up and restore** at the top of the home screen, next to Appearance.

- **Save a backup** (**Download a backup** in a browser) writes one `.rfbackup` file with your projects and folders, the videos, photos and audio they use, your saved clips and your settings. The sheet shows how big it will be first, and with all your footage in it, it can be large. Turn off **Include videos, photos and clips** for a small file that has only your project layouts and settings.
- In the Android app the file is saved to `Documents/ReelForge`. Tap **Share a copy** to send it to Google Drive, email or anywhere else, and keep a copy off the phone: a backup that lives only on the phone is lost along with it. Sharing makes a temporary copy first, so it needs that much free space again, and the app deletes old temporary copies the next time you share.
- **Restore from a backup** shows what is in the file before it changes anything. A restore only adds: nothing already in the app is deleted, a project is replaced only when the backup's copy is newer, and a setting is filled in only when it is missing. Restoring the same file again changes nothing.
- After an update, the Android app asks **Back up now** if it holds projects or clips and you haven't made a backup in the last 7 days.

A backup is never uploaded. It isn't encrypted either, so anyone who has the file can open your projects.

## Privacy

Projects, clips and media are stored in your browser's storage on this device and are never uploaded. Clearing the site's data or uninstalling the app deletes them, so save finished videos to your camera roll and [make a backup](#back-up-and-restore) of anything you want to keep.

## Browser support

ReelForge needs WebCodecs and WebGL2: iOS 17 or later (Safari), or a recent Chrome on Android. Desktop Chrome, Edge and Safari work too.

## Download stats

ReelForge counts how often the Android app is downloaded from the [Latest Android app release](https://github.com/GhuumiRuma/reelforge/releases/tag/android-latest).

- **Total and daily:** the **Download stats** workflow (`.github/workflows/download-stats.yml`) runs every day just after midnight UTC, or whenever you start it from the Actions tab. It saves the running numbers on the [`download-stats` branch](https://github.com/GhuumiRuma/reelforge/tree/download-stats), whose README shows the total, yesterday, the last 7 and 30 days, a table of each day and a week-by-week history.
- **Weekly report:** every Monday it opens a **Weekly downloads** issue for the week that just ended (Monday to Sunday): the week's total, each day's downloads, the best day, the average, the all-time total, and how the week compares with the one before. The issue is labeled `download-report` and assigned to the repository owner. Close it once you've read it, because deleting it makes the workflow post it again.
- **On your computer:** `npm run downloads` prints the same numbers in the terminal and ends with the last finished week. Add `-- --days 30` for a longer daily list (1 to 90 days).

Good to know:

- Counting starts once this is merged to `main`, because GitHub runs scheduled workflows only from the default branch. Downloads of builds that were already replaced can't be recovered, so the total starts from what the current release has, and the first weekly report covers part of a week.
- GitHub counts each release file, and `android.yml` replaces the release on every build, which would reset that count. So before it replaces the release, the workflow writes the running total into the new release's notes as a hidden `rf-banked-downloads` comment. Leave that comment in place if you edit the notes.
- Days run from midnight to midnight UTC. The numbers come from GitHub's own download counter, so they count downloads, not people, and your own downloads are included. The counter can run several minutes behind, so a download near midnight may show up in the next day, and GitHub may not count every repeat download from the same device. A download that finishes in the few seconds while a release is being replaced may be missed.
- GitHub pauses scheduled workflows in a public repository after 60 days without activity. If the daily numbers stop, enable the workflow again from the Actions tab.

## Development

```sh
npm install
npm run dev      # dev server, reachable from your phone on the same Wi-Fi
npm test         # unit tests
npm run build    # type-check and production build into dist/
npm run downloads        # download numbers for the Android app (see Download stats)
node scripts/icons.mjs   # regenerate the app icons in public/
```

Pushing to `main` deploys to GitHub Pages through `.github/workflows/deploy.yml`.

### Android app

The Android app wraps the same web app with [Capacitor](https://capacitorjs.com). Native networking lets it reach YouTube, which browsers block.

```sh
npm run build:android    # build the web app for the app and copy it into android/
npx cap open android     # open in Android Studio to run it on a phone or emulator
```

`.github/workflows/android.yml` builds `ReelForge.apk` on every push and uploads it as a workflow artifact. On `main` it also replaces the **android-latest** release.

Android installs a new APK over an installed app only when both are signed with the same certificate. Otherwise it reports a package conflict, and the only way forward is to uninstall, which deletes the app's data. So every build is signed with one permanent key:

- The repository secrets `ANDROID_KEYSTORE_BASE64` (a base64-encoded keystore), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` hold it, and `main` won't build a release without them.
- `EXPECTED_CERT_SHA256` in `android.yml` is the fingerprint of the certificate that phones already have. The **Check the signature** step reads the certificate back out of the finished APK, lists it in the run summary, and fails the build if the secrets give a different one.
- Keep a copy of the keystore and its passwords somewhere private, outside the repository (`.gitignore` already skips `*.jks`, `*.keystore` and `*.p12`). If the key is lost, the app can't be updated in place again.
- To move to a new key on purpose, change the secrets and `EXPECTED_CERT_SHA256` together. Everyone who has the app will then have to uninstall once, so tell them to make a backup first.
- A fork has no secrets, so its builds use a one-off key. That APK installs on a phone that has no ReelForge, but it can't update an installed copy.
- `capacitor.config.ts` pins the app's origin to `https://localhost`. The browser engine files a page's storage under its origin, so a different one would hide everyone's projects after an update. The manifest sets `hasFragileUserData`, so Android 10 and later asks whether to keep the app's data when someone uninstalls it.

Built with React, TypeScript, Vite, [Mediabunny](https://mediabunny.dev) (WebCodecs), WebGL2 and [Transformers.js](https://huggingface.co/docs/transformers.js) (Whisper).

## License

ReelForge is **source-available**, not open source. The [ReelForge License](LICENSE) lets you use, copy, modify and share it, with these limits:

- **Don't sell it.** You can't sell ReelForge, or a product or service built on it, including hosting or support for a fee. Making and publishing videos with it is fine, even if you earn money from them.
- **Don't use it to promote, encourage or carry out discrimination, harassment or violence** against people because of a protected characteristic, including gender identity and being transgender or nonbinary. Reporting on or criticizing discrimination is fine.
- **Pass it on.** If you share ReelForge, keep the license and its notices with it, so the same terms reach everyone who gets a copy.
- **Names.** The license doesn't cover the ReelForge name, logo or icons, except to say where the software came from.

If this summary and the [LICENSE](LICENSE) differ, the LICENSE wins. The fonts, speech models and code libraries ReelForge uses keep their own licenses, listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
