import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, normalizePath, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// The Android app (Capacitor) serves the build from the root; GitHub Pages serves it from /reelforge/.
const BASE = process.env.CAPACITOR_BUILD ? '/' : '/reelforge/';

// Which commit this build is made from. The app compares it with the one it last ran as, to notice an update.
const BUILD_ID = (process.env.GITHUB_SHA ?? '').slice(0, 12) || 'dev';

// The Experimental features section (src/experimental) goes only into ReelForge Experimental, built with
// `--mode experimental`. Every other build, the public website and APK included, gets src/experimental/off.ts for
// `@experimental`, and experimentalOnly() stops it if any other file from that folder would still end up in it.
export const EXPERIMENTAL_MODE = 'experimental';

export function experimentalOnly(): Plugin {
  let section = '';
  return {
    name: 'rf-experimental-only',
    apply: (_, { command, mode }) => command === 'build' && mode !== EXPERIMENTAL_MODE,
    configResolved(config) {
      section = `${normalizePath(config.root)}/src/experimental/`;
    },
    load(id) {
      const file = normalizePath(id.split('?')[0]);
      if (file.startsWith(section) && file !== `${section}off.ts`) {
        this.error(
          `src/experimental/${file.slice(section.length)} is experimental, so only the experimental build (--mode experimental) may include it. The rest of the app reaches that section only through '@experimental'.`,
        );
      }
      return null;
    },
  };
}

// The license and its third-party notices live once, at the repository root, and ship with every build:
// the website serves them next to index.html and the Android app carries them in its assets.
const LEGAL_FILES = ['LICENSE', 'THIRD_PARTY_NOTICES.md'];

function legalFiles(): Plugin {
  return {
    name: 'rf-legal-files',
    generateBundle() {
      for (const fileName of LEGAL_FILES) {
        this.emitFile({ type: 'asset', fileName, source: readFileSync(new URL(`./${fileName}`, import.meta.url), 'utf8') });
      }
    },
  };
}

export default defineConfig(({ mode }) => ({
  base: BASE,
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  resolve: {
    alias: [
      {
        find: /^@experimental$/,
        replacement: fileURLToPath(new URL(`./src/experimental/${mode === EXPERIMENTAL_MODE ? 'index' : 'off'}.ts`, import.meta.url)),
      },
    ],
  },
  plugins: [
    react(),
    legalFiles(),
    experimentalOnly(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: null,
      includeAssets: ['favicon.svg', 'apple-touch-icon.png'],
      manifest: {
        id: BASE,
        name: 'ReelForge – Video Editor',
        short_name: 'ReelForge',
        description:
          'Edit videos on your phone: trim, split, auto-captions, text, music, voiceover, transitions, filters, green screen and HD export.',
        lang: 'en',
        theme_color: '#0b0b0f',
        background_color: '#0b0b0f',
        display: 'standalone',
        orientation: 'portrait',
        start_url: BASE,
        scope: BASE,
        categories: ['photo', 'video', 'productivity'],
        icons: [
          { src: 'pwa-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Icons are added by includeAssets and the manifest, so they aren't globbed again here.
        globPatterns: ['**/*.{js,css,html}', 'assets/*-latin-[0-9]*-*.woff2'],
        // The speech-recognition runtime is large and optional: cache it the first time captions are used.
        globIgnores: ['**/captions.worker*', '**/*.wasm'],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        // The legal files are plain files next to index.html, not app screens, so they open as themselves.
        navigateFallbackDenylist: [/\/(LICENSE|THIRD_PARTY_NOTICES\.md)(\?.*)?$/],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.endsWith('.woff2') || url.pathname.endsWith('.woff'),
            handler: 'CacheFirst',
            options: { cacheName: 'rf-fonts', expiration: { maxEntries: 300 } },
          },
          {
            urlPattern: ({ url }) => url.pathname.includes('/assets/captions.worker'),
            handler: 'CacheFirst',
            options: { cacheName: 'rf-captions', expiration: { maxEntries: 8 } },
          },
        ],
      },
    }),
  ],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 6000,
  },
}));
