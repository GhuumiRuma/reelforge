import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bankMarker, LEDGER_BRANCH, LEDGER_FILE, readBanked, REPORT_LABEL } from './download-stats.mjs';

const root = new URL('../', import.meta.url);
// Windows checkouts turn line endings into CRLF; the patterns below are written for LF.
const read = (path) => readFileSync(new URL(path, root), 'utf8').replace(/\r\n/g, '\n');

/** The indented lines under a top-level key such as `on:` or `permissions:`. */
const section = (yaml, key) => yaml.match(new RegExp(`^${key}:[^\\S\\n]*\\n((?:[^\\S\\n]+.*\\n|\\n)+)`, 'm'))?.[1] ?? '';

// These are the places where the workflows and scripts/download-stats.mjs have to agree. Each one fails
// quietly in CI (a dropped count, a missing weekly issue), so they are checked here instead.
describe('download count carried across releases', () => {
  const workflow = read('.github/workflows/android.yml');
  const publish = workflow.slice(workflow.indexOf('- name: Publish the "Latest Android app" release'));

  it('asks the script for the old release count and puts it in the new notes', () => {
    expect(publish).toContain('node scripts/download-stats.mjs bank');
    expect(publish).toContain('--notes-file "$RUNNER_TEMP/release-notes.md"');
    expect(publish.indexOf('download-stats.mjs bank')).toBeLessThan(publish.indexOf('gh release delete'));
  });

  it('accepts the marker the script writes and nothing else', () => {
    const pattern = publish.match(/grep -Eqx '([^']+)'/)?.[1];
    expect(pattern).toBeTruthy();
    const accepts = (text) => new RegExp(`^${pattern}$`).test(text);
    expect(accepts(bankMarker(0))).toBe(true);
    expect(accepts(bankMarker(48213))).toBe(true);
    expect(accepts('')).toBe(false);
    expect(accepts('<!-- rf-banked-downloads:many -->')).toBe(false);
    expect(readBanked(bankMarker(48213))).toBe(48213);
  });
});

describe('daily download count workflow', () => {
  const workflow = read('.github/workflows/download-stats.yml');

  it('runs once a day, or when started by hand, and never on a push', () => {
    const triggers = section(workflow, 'on');
    expect(triggers).toMatch(/schedule:\s*\n\s*- cron: '\d{1,2} \d{1,2} \* \* \*'/);
    expect(triggers).toContain('workflow_dispatch:');
    expect(triggers).not.toMatch(/\bpush\b|\bpull_request/);
  });

  it('may save its numbers and open issues, and nothing else', () => {
    const granted = section(workflow, 'permissions').split('\n').map((line) => line.trim()).filter(Boolean);
    expect(granted.sort()).toEqual(['contents: write', 'issues: write']);
  });

  it('keeps one count running at a time', () => {
    expect(section(workflow, 'concurrency')).toContain('cancel-in-progress: false');
  });

  it('saves the numbers where the script and the docs expect them', () => {
    expect(workflow).toContain(`git ls-remote --exit-code --heads origin ${LEDGER_BRANCH}`);
    expect(workflow).toContain(`switch --orphan ${LEDGER_BRANCH}`);
    expect(workflow).toContain(`git push origin HEAD:${LEDGER_BRANCH}`);
    expect(workflow).toContain(`--ledger "$RUNNER_TEMP/stats/${LEDGER_FILE}"`);
  });

  it('files each weekly report under the one label it looks for', () => {
    const uses = workflow.match(new RegExp(`--label ${REPORT_LABEL}(?![\\w-])`, 'g')) ?? [];
    expect(uses.length).toBeGreaterThanOrEqual(2);
    expect(workflow).not.toMatch(new RegExp(`--label (?!${REPORT_LABEL}(?![\\w-]))`));
  });
});

describe('npm run downloads', () => {
  it('prints the live report from the same script', () => {
    expect(JSON.parse(read('package.json')).scripts.downloads).toBe('node scripts/download-stats.mjs report');
  });
});
