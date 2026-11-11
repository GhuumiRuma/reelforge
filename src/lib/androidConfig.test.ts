import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import config from '../../capacitor.config';

const root = new URL('../../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');

// Android installs a new APK over an old one only when the package id matches (and the signing key,
// which CI checks). Changing this id turns every update into a second app with none of the user's data.
const APP_ID = 'io.github.monicariverawork.reelforge';

describe('Android update identity', () => {
  it('keeps one package id everywhere', () => {
    expect(config.appId).toBe(APP_ID);
    expect(read('android/app/build.gradle')).toContain(`applicationId "${APP_ID}"`);
  });

  it('numbers each build above the last so it installs as an update', () => {
    const gradle = read('android/app/build.gradle');
    expect(gradle).toMatch(/versionCode\(\(System\.getenv\("VERSION_CODE"\)/);
    expect(read('.github/workflows/android.yml')).toContain('VERSION_CODE: ${{ github.run_number }}');
  });
});

describe('Android data origin', () => {
  // The WebView keeps projects in IndexedDB keyed by the page origin, https://localhost.
  it('pins the origin the app is served from', () => {
    expect(config.server?.androidScheme).toBe('https');
    expect(config.server?.hostname).toBe('localhost');
    expect(config.server?.url).toBeUndefined();
  });

  it('offers to keep app data when the app is uninstalled', () => {
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    expect(manifest).toMatch(/<application[^>]*android:hasFragileUserData="true"/);
  });
});
