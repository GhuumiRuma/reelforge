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

  it('has no placeholders left in it', () => {
    expect(notices).not.toMatch(/@@\w+@@/);
  });

  it('names every package the app depends on', () => {
    for (const name of Object.keys(JSON.parse(read('package.json')).dependencies)) {
      expect(notices, name).toContain(`\`${name}\``);
    }
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
