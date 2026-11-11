import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const root = new URL('../', import.meta.url);
// Windows checkouts turn line endings into CRLF; the checks below are written for LF.
const read = (path) => readFileSync(new URL(path, root), 'utf8').replace(/\r\n/g, '\n');
// The license texts are hard-wrapped, so phrases are matched with every run of whitespace as one space.
const flat = (text) => text.replace(/\s+/g, ' ').trim();

// These phrases are what the license is for. Reword the rest freely, but a change that drops one of them
// changes what people may do with ReelForge, so it should fail here and be a decision.
describe('ReelForge License', () => {
  const license = flat(read('LICENSE'));

  it('keeps the Commons Clause, so nobody can sell the software', () => {
    expect(license).toContain(
      'the grant of rights under the License will not include, and the License does not grant to you, the right to Sell the Software.',
    );
    expect(license).toContain(
      '"Sell" means practicing any or all of the rights granted to you under the License to provide to third parties, for a fee or other consideration',
    );
    expect(license).toContain('Software: ReelForge License: ReelForge License, version 1.0 (this document) Licensor: GhuumiRuma');
  });

  it('lets people make and publish videos, even for money', () => {
    expect(license).toContain(
      'Making, editing or publishing videos or other content with the Software is not Selling, even if you are paid for that content or it earns ad revenue.',
    );
  });

  it('bans discrimination and names gender identity and transgender and nonbinary people', () => {
    expect(license).toContain(
      'promotes, encourages or carries out discrimination, harassment or violence against people because of a protected characteristic',
    );
    expect(license).toContain('gender identity, gender expression, transgender or nonbinary status');
    expect(license).toContain('Reporting on, documenting, teaching about or criticizing discrimination is not a violation.');
    expect(license).toContain('If you give the Software or a work based on it to anyone, you must pass this section on.');
  });

  it('leaves third-party components under their own licenses', () => {
    expect(license).toContain('described in THIRD_PARTY_NOTICES.md and listed in package-lock.json');
    expect(license).toContain(
      'including the right to modify or replace a component and to reverse engineer the Software to debug your own modifications',
    );
  });
});

describe('third-party notices', () => {
  const notices = read('THIRD_PARTY_NOTICES.md');
  const flatNotices = flat(notices);
  const lock = JSON.parse(read('package-lock.json')).packages;
  const fonts = [...new Set([...read('src/main.tsx').matchAll(/@fontsource\/([a-z-]+)\//g)].map((m) => m[1]))];

  // What ships is what npm installs for package.json's dependencies, for the packages those need, and so on. That includes packages
  // built into another package: Transformers.js has `@huggingface/jinja` and `@huggingface/tokenizers` inside its prebuilt web file,
  // so no build log lists them, but they ship.
  // Packages in that tree that never reach a device are cut where they come in, at the one package that needs them, so anything else
  // that needs one still brings it in. The test 'leaves out only packages that the shipped code never loads' checks each reason.
  const notShipped = {
    // Only Transformers.js's Node.js builds load these. Its web build, which the app bundles, does not.
    '@huggingface/transformers': ['onnxruntime-node', 'sharp'],
    // The one ONNX Runtime Web build the app loads, ort.webgpu.bundle.min.mjs, has everything it needs inside it.
    'onnxruntime-web': ['flatbuffers', 'guid-typescript', 'long', 'platform', 'protobufjs'],
    // @capacitor/core lists tslib, but none of its code uses it.
    '@capacitor/core': ['tslib'],
  };
  const folder = (key) => key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
  // The copy of a package that `from` (a lockfile key, or '' for package.json) gets: its own node_modules first, then each one above.
  const nearestCopy = (from, name) => {
    for (let dir = from; ; dir = dir.slice(0, Math.max(dir.lastIndexOf('node_modules/') - 1, 0))) {
      const key = [dir, 'node_modules', name].filter(Boolean).join('/');
      if (lock[key]) return key;
      if (!dir) throw new Error(`${name}, needed by ${from || 'package.json'}, is not in package-lock.json`);
    }
  };
  const shipped = (() => {
    const seen = new Set();
    const visit = (key) => {
      if (seen.has(key)) return;
      seen.add(key);
      // Optional dependencies (platform binaries and the like) are skipped; none of the packages that ship has any.
      const { dependencies = {}, peerDependencies = {}, peerDependenciesMeta = {} } = lock[key];
      const needs = [...Object.keys(dependencies), ...Object.keys(peerDependencies).filter((peer) => !peerDependenciesMeta[peer]?.optional)];
      for (const need of needs) {
        // @types/* packages are type declarations, which the build erases.
        if (need.startsWith('@types/') || notShipped[folder(key)]?.includes(need)) continue;
        visit(nearestCopy(key, need));
      }
    };
    for (const name of Object.keys(JSON.parse(read('package.json')).dependencies)) visit(nearestCopy('', name));
    return [...new Set([...seen].map(folder))].sort();
  })();
  const missingFrom = (text) => shipped.filter((name) => !text.includes(`\`${name}\``));
  const transformers = nearestCopy('', '@huggingface/transformers');

  it('has no placeholders left in it', () => {
    expect(notices).not.toMatch(/@@\w+@@/);
  });

  it('names every package that ships, including the ones other packages bring along', () => {
    expect(missingFrom(notices), 'shipped packages the notices do not name').toEqual([]);
  });

  it('finds the packages built into Transformers.js, and skips the ones that never ship', () => {
    expect(shipped).toEqual(
      expect.arrayContaining(['@huggingface/transformers', '@huggingface/jinja', '@huggingface/tokenizers', 'onnxruntime-web', 'onnxruntime-common']),
    );
    for (const name of ['vite', 'vitest', 'onnxruntime-node', 'sharp', 'tslib', '@types/dom-webcodecs']) {
      expect(shipped, name).not.toContain(name);
    }
  });

  it('would notice a shipped package that the notices drop', () => {
    expect(missingFrom(notices.replaceAll('`@huggingface/jinja`', 'Jinja'))).toContain('@huggingface/jinja');
  });

  it('leaves out only packages that the shipped code never loads', () => {
    // Transformers.js's web build imports some packages and has others built in; a built-in one leaves a path comment.
    const web = read(`${transformers}/dist/transformers.web.js`);
    const loads = (name) => new RegExp(`^import\\b[^'"]*?from\\s*["']${name}["']|^// .*node_modules/${name}/`, 'm').test(web);
    expect(loads('onnxruntime-web/webgpu'), 'the web build imports ONNX Runtime Web').toBe(true);
    expect(loads('@huggingface/jinja'), 'the web build has Jinja built in').toBe(true);
    for (const name of ['onnxruntime-node', 'sharp']) {
      expect(loads(name), `the web build loads ${name}`).toBe(false);
    }

    // The WebGPU build of ONNX Runtime Web is a bundle. Its source map lists what is inside it, and none of that is from node_modules.
    const { sources } = JSON.parse(read(`${nearestCopy(transformers, 'onnxruntime-web')}/dist/ort.webgpu.bundle.min.mjs.map`));
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.filter((source) => source.includes('node_modules'))).toEqual([]);

    expect(read(`${nearestCopy('', '@capacitor/core')}/dist/index.js`)).not.toContain('tslib');
  });

  it('lists each font the app loads, with the copyright line from its own package', () => {
    expect(fonts.length).toBeGreaterThan(0);
    for (const font of fonts) {
      const row = notices.split('\n').find((line) => line.startsWith('|') && line.includes(`\`@fontsource/${font}\``));
      expect(row, `${font} has a row in the Fonts table`).toBeTruthy();
      const copyright = flat(row.split('|')[4]);
      expect(flat(read(`node_modules/@fontsource/${font}/LICENSE`)), font).toContain(copyright);
    }
  });

  it('names the Mediabunny version the lockfile installs, which the source links point at', () => {
    for (const name of ['mediabunny', '@mediabunny/aac-encoder']) {
      expect(notices, name).toContain(lock[`node_modules/${name}`].version);
    }
  });

  it('points the Hugging Face source links at the versions the lockfile installs', () => {
    const version = (name) => lock[nearestCopy(transformers, name)].version;
    expect(notices).toContain(`/huggingface.js/tree/jinja-v${version('@huggingface/jinja')}/packages/jinja>`);
    expect(notices).toContain(`/tokenizers.js/tree/v${version('@huggingface/tokenizers')}>`);
  });

  it('copies the Jinja copyright line from its own package', () => {
    const row = notices.split('\n').find((line) => line.startsWith('|') && line.includes('`@huggingface/jinja`'));
    expect(row, 'Jinja has a row in the Speech recognition table').toBeTruthy();
    const copyright = flat(row.split('|')[3]).split('. <')[0];
    expect(copyright).toMatch(/^Copyright \(c\) \d{4} \S/);
    expect(flat(read(`${nearestCopy(transformers, '@huggingface/jinja')}/LICENSE`))).toContain(copyright);
  });

  it('includes the full text of the font licenses', () => {
    const ofl = read('node_modules/@fontsource/anton/LICENSE');
    expect(flatNotices).toContain(flat(ofl.slice(ofl.indexOf('SIL OPEN FONT LICENSE Version 1.1'))));

    const apache = read('node_modules/@fontsource/permanent-marker/LICENSE');
    const end = 'END OF TERMS AND CONDITIONS';
    expect(flatNotices).toContain(flat(apache.slice(apache.indexOf('TERMS AND CONDITIONS FOR USE'), apache.indexOf(end) + end.length)));
  });

  it('includes the full LGPL 2.1 text for the AAC encoder', () => {
    const lgpl = notices.slice(notices.indexOf('### GNU Lesser General Public License 2.1'), notices.indexOf('### SIL Open Font License 1.1'));
    expect(lgpl.length).toBeGreaterThan(26000);
    expect(flat(lgpl)).toContain('GNU LESSER GENERAL PUBLIC LICENSE Version 2.1, February 1999');
    expect(flat(lgpl)).toContain('reverse engineering for debugging such modifications');
    expect(flat(lgpl)).toContain("That's all there is to it!");
  });

  it('includes the MIT, ISC and BSD license texts', () => {
    expect(flatNotices).toContain('Permission is hereby granted, free of charge, to any person obtaining a copy of this software');
    expect(flatNotices).toContain('Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted');
    expect(flatNotices).toContain('Neither the name of Google Inc. nor the names of its contributors may be used');
  });

  it('pins the FFmpeg source to one commit and to the Mediabunny tag the lockfile installs, and keeps the written offer', () => {
    const start = notices.indexOf('## FFmpeg AAC encoder');
    expect(start, 'the notices have an FFmpeg AAC encoder section').toBeGreaterThan(-1);
    const section = notices.slice(start, notices.indexOf('\n## ', start));

    // A branch or a short hash can move or be ambiguous. Only a full commit hash names the FFmpeg source behind the shipped encoder.
    expect([...new Set(section.match(/\b[0-9a-f]{40}\b/g))], 'one full FFmpeg commit hash').toHaveLength(1);

    // A new @mediabunny/aac-encoder can be a new build of FFmpeg, so the pin and the links to the recipe get checked again.
    const tags = [...section.matchAll(/\/mediabunny\/(?:blob|tree)\/v(\d+\.\d+\.\d+)\//g)].map((m) => m[1]);
    expect(tags.length, 'the section links the Mediabunny recipe at a version tag').toBeGreaterThan(0);
    expect(new Set(tags), 'the links name the locked @mediabunny/aac-encoder version').toEqual(new Set([lock['node_modules/@mediabunny/aac-encoder'].version]));

    expect(flat(section)).toContain('written offer');
    expect(flat(section)).toContain('three years');
  });
});

describe('where the license shows up', () => {
  it('is named in package.json, which stays private', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.license).toBe('SEE LICENSE IN LICENSE');
    expect(pkg.private).toBe(true);
  });

  it('is linked from the README', () => {
    const readme = read('README.md');
    expect(readme).toContain('](LICENSE)');
    expect(readme).toContain('](THIRD_PARTY_NOTICES.md)');
  });

  it('ships in every build and opens as a plain file under the service worker', () => {
    const config = read('vite.config.ts');
    expect(config).toContain("const LEGAL_FILES = ['LICENSE', 'THIRD_PARTY_NOTICES.md'];");
    expect(config).toContain("name: 'rf-legal-files'");

    // Without this the installed app answers a visit to /LICENSE with the app shell.
    const source = config.match(/navigateFallbackDenylist: \[\/(.+)\/\]/)?.[1];
    expect(source).toBeTruthy();
    const denied = new RegExp(source);
    for (const path of ['/LICENSE', '/reelforge/LICENSE', '/reelforge/THIRD_PARTY_NOTICES.md', '/reelforge/LICENSE?x=1']) {
      expect(denied.test(path), path).toBe(true);
    }
    for (const path of ['/', '/reelforge/', '/reelforge/index.html', '/reelforge/LICENSED']) {
      expect(denied.test(path), path).toBe(false);
    }
  });
});
