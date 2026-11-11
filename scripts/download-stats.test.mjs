import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  bankMarker,
  dailyCounts,
  dashboard,
  downloadsBetween,
  emptyLedger,
  lastFullWeek,
  parseLedger,
  readBanked,
  recordSnapshot,
  releaseDownloads,
  serializeLedger,
  startOfWeek,
  terminalReport,
  totalAt,
  totalDownloads,
  weekSummary,
  weeklyReport,
} from './download-stats.mjs';

const SCRIPT = fileURLToPath(new URL('./download-stats.mjs', import.meta.url));
const DAY = 86_400_000;
const at = (text) => Date.parse(text);

/** A ledger from [time, raw GitHub total] pairs. */
const ledgerOf = (points) => points.reduce((ledger, [t, raw]) => recordSnapshot(ledger, raw, at(t)), emptyLedger());

/**
 * A ledger with a snapshot at 00:10 UTC every day from `firstDay`, where `perDay[i]` downloads happened on
 * day i. It has one more snapshot than days, so the last day is complete.
 */
function dailyLedger(firstDay, base, perDay) {
  const points = [];
  let total = base;
  for (let i = 0; i <= perDay.length; i++) {
    points.push([new Date(at(firstDay) + i * DAY + 10 * 60_000).toISOString(), total]);
    total += perDay[i] ?? 0;
  }
  return ledgerOf(points);
}

const apk = (download_count, name = 'ReelForge.apk') => ({ name, download_count });
const release = (body, ...assets) => ({ tag_name: 'android-latest', draft: false, body, assets });

describe('banked counts', () => {
  it('reads the count a release carries over', () => {
    expect(readBanked(`Install it.\n\n${bankMarker(41)}`)).toBe(41);
    expect(readBanked('x <!--   rf-banked-downloads:7   --> y')).toBe(7);
    expect(readBanked(bankMarker(123))).toBe(123);
  });

  it('treats anything else as nothing banked', () => {
    expect(readBanked('Install it.')).toBe(0);
    expect(readBanked(null)).toBe(0);
    expect(readBanked(undefined)).toBe(0);
    expect(readBanked(12)).toBe(0);
    expect(readBanked('<!-- rf-banked-downloads:99999999999999999999 -->')).toBe(0);
  });
});

describe('counting a release', () => {
  it('adds the banked count to the live downloads of its APKs only', () => {
    const r = release(bankMarker(10), apk(5), apk(2, 'Other.APK'), { name: 'notes.txt', download_count: 100 });
    expect(releaseDownloads(r)).toEqual({ banked: 10, live: 7, apks: 2 });
  });

  it('copes with missing or odd fields', () => {
    expect(releaseDownloads({})).toEqual({ banked: 0, live: 0, apks: 0 });
    expect(releaseDownloads(release(null, { name: 'ReelForge.apk' }))).toEqual({ banked: 0, live: 0, apks: 1 });
    expect(releaseDownloads(release(null, apk(-4), apk('9')))).toEqual({ banked: 0, live: 0, apks: 2 });
  });

  it('totals every published release and skips drafts', () => {
    const releases = [release(bankMarker(3), apk(4)), { ...release(null, apk(50)), draft: true }, release(null, apk(1))];
    expect(totalDownloads(releases)).toEqual({ total: 8, found: true });
  });

  it('says nothing was found when there is no APK to count', () => {
    expect(totalDownloads([])).toEqual({ total: 0, found: false });
    expect(totalDownloads([release('notes', { name: 'notes.txt', download_count: 9 })])).toEqual({ total: 0, found: false });
    expect(totalDownloads([null])).toEqual({ total: 0, found: false });
  });

  it('counts a new release whose APK is still uploading from its banked count', () => {
    expect(totalDownloads([release(bankMarker(16))])).toEqual({ total: 16, found: true });
  });

  it('keeps counting through a rebuild: the new release starts from what the old one reached', () => {
    const before = release(bankMarker(10), apk(6));
    const { banked, live } = releaseDownloads(before);
    const after = release(bankMarker(banked + live), apk(0));
    expect(totalDownloads([before]).total).toBe(16);
    expect(totalDownloads([after]).total).toBe(16);
    after.assets[0].download_count = 3;
    expect(totalDownloads([after]).total).toBe(19);
  });
});

describe('the ledger', () => {
  it('survives saving and loading, one line per snapshot', () => {
    const ledger = ledgerOf([
      ['2026-06-01T00:10:00Z', 5],
      ['2026-06-02T00:10:12Z', 9],
    ]);
    const text = serializeLedger(ledger);
    expect(text).toContain('    {"t":"2026-06-01T00:10:00.000Z","total":5},\n    {"t":"2026-06-02T00:10:12.000Z","total":9}\n');
    expect(text.endsWith('\n')).toBe(true);
    expect(parseLedger(text)).toEqual(ledger);
    expect(parseLedger(serializeLedger(emptyLedger()))).toEqual(emptyLedger());
  });

  it('refuses a file it does not understand rather than starting over', () => {
    expect(() => parseLedger('nope')).toThrow(/not valid JSON/);
    expect(() => parseLedger('{"version":2,"offset":0,"last":0,"series":[]}')).toThrow(/not a download ledger/);
    expect(() => parseLedger('{"version":1,"offset":-1,"last":0,"series":[]}')).toThrow(/not a download ledger/);
    expect(() => parseLedger('{"version":1,"offset":0,"last":0,"series":[{"t":"soon","total":1}]}')).toThrow(/bad snapshot/);
    expect(() => parseLedger('{"version":1,"offset":0,"last":0,"series":[{"t":"2026-06-01T00:00:00Z","total":-1}]}')).toThrow(/bad snapshot/);
    const backwards = '{"version":1,"offset":0,"last":2,"series":[{"t":"2026-06-02T00:00:00Z","total":1},{"t":"2026-06-01T00:00:00Z","total":2}]}';
    expect(() => parseLedger(backwards)).toThrow(/bad snapshot/);
  });

  it('records growth as it comes', () => {
    const ledger = ledgerOf([
      ['2026-06-01T00:10:00Z', 5],
      ['2026-06-02T00:10:00Z', 9],
    ]);
    expect(ledger.series.map((p) => p.total)).toEqual([5, 9]);
    expect(ledger.offset).toBe(0);
    expect(ledger.last).toBe(9);
    expect(ledger.adjustments).toEqual([]);
  });

  it('keeps the total steady when GitHub starts again from zero', () => {
    const ledger = ledgerOf([
      ['2026-06-01T00:10:00Z', 5],
      ['2026-06-02T00:10:00Z', 9],
      ['2026-06-03T00:10:00Z', 0],
      ['2026-06-04T00:10:00Z', 3],
    ]);
    expect(ledger.series.map((p) => p.total)).toEqual([5, 9, 9, 12]);
    expect(ledger.offset).toBe(9);
    expect(ledger.last).toBe(3);
    expect(ledger.adjustments).toEqual([{ t: '2026-06-03T00:10:00.000Z', added: 9 }]);
  });

  it('does not double count when a read is only a little stale', () => {
    const ledger = ledgerOf([
      ['2026-06-01T00:10:00Z', 10],
      ['2026-06-02T00:10:00Z', 9],
      ['2026-06-03T00:10:00Z', 11],
    ]);
    expect(ledger.series.map((p) => p.total)).toEqual([10, 10, 12]);
  });

  it('never stamps a snapshot earlier than the one before it', () => {
    const ledger = ledgerOf([
      ['2026-06-02T00:10:00Z', 5],
      ['2026-06-01T23:00:00Z', 6],
    ]);
    expect(ledger.series[1].t).toBe('2026-06-02T00:10:00.000Z');
  });

  it('leaves the ledger it was given alone', () => {
    const before = ledgerOf([['2026-06-01T00:10:00Z', 5]]);
    const copy = JSON.stringify(before);
    recordSnapshot(before, 0, at('2026-06-02T00:10:00Z'));
    expect(JSON.stringify(before)).toBe(copy);
  });
});

describe('days and weeks', () => {
  it('finds the Monday a week starts on', () => {
    expect(new Date(at('2026-06-01T00:00:00Z')).getUTCDay()).toBe(1);
    expect(startOfWeek(at('2026-06-03T12:00:00Z'))).toBe(at('2026-06-01T00:00:00Z'));
    expect(startOfWeek(at('2026-06-07T23:59:59Z'))).toBe(at('2026-06-01T00:00:00Z'));
    expect(startOfWeek(at('2026-06-01T00:00:00Z'))).toBe(at('2026-06-01T00:00:00Z'));
    expect(startOfWeek(at('2026-06-08T00:00:00Z'))).toBe(at('2026-06-08T00:00:00Z'));
  });

  it('reports on the most recent week that has finished', () => {
    expect(lastFullWeek(at('2026-06-08T00:10:00Z'))).toBe(at('2026-06-01T00:00:00Z'));
    expect(lastFullWeek(at('2026-06-07T23:59:00Z'))).toBe(at('2026-05-25T00:00:00Z'));
    expect(lastFullWeek(at('2026-06-03T12:00:00Z'))).toBe(at('2026-05-25T00:00:00Z'));
  });
});

describe('totals over time', () => {
  const series = ledgerOf([
    ['2026-06-01T00:10:00Z', 10],
    ['2026-06-02T00:10:00Z', 20],
  ]).series;

  it('is exact at a snapshot and in between them', () => {
    expect(totalAt(series, at('2026-06-01T00:10:00Z'))).toBe(10);
    expect(totalAt(series, at('2026-06-01T12:10:00Z'))).toBe(15);
    expect(totalAt(series, at('2026-06-02T00:10:00Z'))).toBe(20);
  });

  it('is unknown before the first snapshot and after the last', () => {
    expect(totalAt(series, at('2026-06-01T00:09:59Z'))).toBeNull();
    expect(totalAt(series, at('2026-06-02T00:10:01Z'))).toBeNull();
    expect(totalAt([], at('2026-06-02T00:00:00Z'))).toBeNull();
  });

  it('takes the later of two snapshots made at the same moment', () => {
    const same = [
      { t: '2026-06-01T00:00:00.000Z', total: 1 },
      { t: '2026-06-01T00:00:00.000Z', total: 3 },
    ];
    expect(totalAt(same, at('2026-06-01T00:00:00Z'))).toBe(3);
  });

  it('counts the downloads in a day, and they add up to what the total grew by', () => {
    const days = ledgerOf([
      ['2026-06-01T00:10:00Z', 100],
      ['2026-06-02T00:10:00Z', 107],
      ['2026-06-03T00:10:00Z', 107],
      ['2026-06-04T00:10:00Z', 110],
    ]).series;
    const counted = dailyCounts(days, at('2026-06-01T00:00:00Z'), 3);
    expect(counted.map((d) => d.n)).toEqual([7, 0, 3]);
    expect(counted.map((d) => d.partial)).toEqual([true, false, false]);
    expect(counted[0].n + counted[1].n + counted[2].n).toBe(110 - 100);
  });

  it('has no number for days before counting started or after the last snapshot', () => {
    const counted = dailyCounts(series, at('2026-05-31T00:00:00Z'), 5);
    // Jun 2 is only ten minutes old at the last snapshot, so it has a number but a partial one.
    expect(counted.map((d) => d.n)).toEqual([null, 10, 0, null, null]);
    expect(counted.map((d) => d.partial)).toEqual([false, true, true, false, false]);
    expect(downloadsBetween(series, at('2026-06-05T00:00:00Z'), at('2026-06-06T00:00:00Z'))).toBeNull();
    expect(downloadsBetween(ledgerOf([['2026-06-01T00:10:00Z', 5]]).series, at('2026-06-01T00:00:00Z'), at('2026-06-02T00:00:00Z'))).toBeNull();
    expect(downloadsBetween([], 0, DAY)).toBeNull();
  });

  it('marks a day that is still going as partial', () => {
    const live = ledgerOf([
      ['2026-05-31T00:10:00Z', 50],
      ['2026-06-01T00:10:00Z', 60],
      ['2026-06-01T15:00:00Z', 64],
    ]).series;
    expect(downloadsBetween(live, at('2026-06-01T00:00:00Z'), at('2026-06-02T00:00:00Z'))).toEqual({ n: 4, partial: true });
    // Counting began ten minutes into May 31, so that day is cut short at the start.
    expect(downloadsBetween(live, at('2026-05-31T00:00:00Z'), at('2026-06-01T00:00:00Z'))).toEqual({ n: 10, partial: true });
  });

  it('spreads a gap in the snapshots over the days it covers', () => {
    const gap = ledgerOf([
      ['2026-06-01T00:10:00Z', 0],
      ['2026-06-04T00:10:00Z', 30],
    ]).series;
    const counted = dailyCounts(gap, at('2026-06-02T00:00:00Z'), 2);
    expect(counted.map((d) => d.n)).toEqual([10, 10]);
  });
});

describe('a week', () => {
  // The week before has 30 downloads and the week being reported has 42.
  const full = dailyLedger('2026-05-24', 100, [2, 3, 4, 2, 5, 6, 1, 9, 5, 8, 0, 11, 3, 6, 9]);
  const monday = at('2026-06-01T00:00:00Z');

  it('adds up its days and picks the best one', () => {
    const week = weekSummary(full.series, monday);
    expect(week.days.map((d) => d.n)).toEqual([5, 8, 0, 11, 3, 6, 9]);
    expect(week.total).toBe(42);
    expect(week.known).toBe(7);
    expect(week.complete).toBe(true);
    expect(week.best.n).toBe(11);
    expect(new Date(week.best.day).toISOString()).toBe('2026-06-04T00:00:00.000Z');
    expect(week.average).toBe(6);
  });

  it('gives the earliest day when two are tied for best', () => {
    const tied = dailyLedger('2026-06-01', 0, [4, 9, 2, 9, 0, 0, 1]);
    expect(new Date(weekSummary(tied.series, monday).best.day).toISOString()).toBe('2026-06-02T00:00:00.000Z');
  });

  it('is not complete when counting started part-way through', () => {
    const week = weekSummary(full.series, at('2026-05-18T00:00:00Z'));
    expect(week.known).toBe(1);
    expect(week.complete).toBe(false);
  });

  it('has nothing to say about a week that was never recorded', () => {
    expect(weekSummary(full.series, at('2026-04-27T00:00:00Z')).known).toBe(0);
    expect(weeklyReport(full, 'o/r', at('2026-04-27T00:00:00Z'))).toBeNull();
    expect(weeklyReport(emptyLedger(), 'o/r', monday)).toBeNull();
  });
});

describe('the weekly report', () => {
  const full = dailyLedger('2026-05-24', 100, [2, 3, 4, 2, 5, 6, 1, 9, 5, 8, 0, 11, 3, 6, 9]);
  const monday = at('2026-06-01T00:00:00Z');

  it('titles the issue by the dates it covers', () => {
    expect(weeklyReport(full, 'o/r', monday).title).toBe('Weekly downloads: 2026-06-01 to 2026-06-07');
  });

  it('lays out the week day by day with a comparison to the week before', () => {
    const bars = (n) => '█'.repeat(n);
    expect(weeklyReport(full, 'o/r', monday).body).toBe(
      [
        '**42 downloads** from Mon 1 Jun to Sun 7 Jun 2026, up 12 from 30 the week before.',
        '',
        '| Day | Downloads | |',
        '| --- | ---: | --- |',
        `| Mon 1 Jun | 5 | ${bars(11)} |`,
        `| Tue 2 Jun | 8 | ${bars(17)} |`,
        '| Wed 3 Jun | 0 |  |',
        `| Thu 4 Jun | 11 | ${bars(24)} |`,
        `| Fri 5 Jun | 3 | ${bars(7)} |`,
        `| Sat 6 Jun | 6 | ${bars(13)} |`,
        `| Sun 7 Jun | 9 | ${bars(20)} |`,
        '| **Total** | **42** | |',
        '',
        '- **Best day:** Thu 4 Jun, 11 downloads',
        '- **Average:** 6.0 a day',
        '- **All-time total:** 174 downloads, as of Mon 8 Jun 2026 at 00:10 UTC',
        '',
        'Days run from midnight to midnight UTC. GitHub counts every completed download of the APK, so repeat downloads and your own count too. The running numbers are on the [download-stats branch](https://github.com/o/r/tree/download-stats).',
      ].join('\n'),
    );
  });

  it('says when a week was down, flat, or has nothing to compare with', () => {
    const down = dailyLedger('2026-05-24', 0, [0, 9, 9, 9, 9, 9, 9, 9, 1, 1, 1, 1, 1, 1, 1]);
    expect(weeklyReport(down, 'o/r', monday).body).toContain('**7 downloads** from Mon 1 Jun to Sun 7 Jun 2026, down 56 from 63 the week before.');
    const flat = dailyLedger('2026-05-24', 0, [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(weeklyReport(flat, 'o/r', monday).body).toContain(', the same as the week before (7).');
    const single = dailyLedger('2026-05-31', 0, [0, 1, 1, 1, 1, 1, 1, 1]);
    expect(weeklyReport(single, 'o/r', monday).body).not.toContain('the week before');
  });

  it('uses the singular for one download', () => {
    const one = dailyLedger('2026-06-01', 0, [1, 0, 0, 0, 0, 0, 0]);
    const body = weeklyReport(one, 'o/r', monday).body;
    expect(body).toContain('**1 download** from');
    expect(body).toContain('- **Best day:** Mon 1 Jun, 1 download\n');
  });

  it('is honest when counting started part-way through the week', () => {
    const started = ledgerOf([
      ['2026-06-03T14:30:00Z', 7],
      ['2026-06-04T00:10:00Z', 9],
      ['2026-06-05T00:10:00Z', 9],
      ['2026-06-06T00:10:00Z', 12],
      ['2026-06-07T00:10:00Z', 12],
      ['2026-06-08T00:10:00Z', 15],
    ]);
    const { body } = weeklyReport(started, 'o/r', monday);
    expect(body).toContain('**8 downloads** from Mon 1 Jun to Sun 7 Jun 2026.');
    expect(body).toContain('| Mon 1 Jun | – |  |');
    expect(body).toContain('| Wed 3 Jun | 2\\* |');
    expect(body).toContain('Counting started on Wed 3 Jun 2026 at 14:30 UTC');
    expect(body).toContain('- **Average:** 1.6 a day');
  });
});

describe('the dashboard', () => {
  const full = dailyLedger('2026-05-24', 100, [2, 3, 4, 2, 5, 6, 1, 9, 5, 8, 0, 11, 3, 6, 9]);
  const now = at('2026-06-08T00:10:00Z');
  const text = dashboard(full, 'o/r', now);

  it('leads with the total and the recent periods', () => {
    expect(text).toContain('# ReelForge download stats');
    expect(text).toContain('**174 downloads** of the Android app so far.');
    expect(text).toContain('| Yesterday | Last 7 days | Last 30 days |\n| ---: | ---: | ---: |\n| 9 | 42 | 74 |');
    expect(text).toContain('Counting since Sun 24 May 2026, so the longer periods only cover the days since then.');
    expect(text).toContain('https://github.com/o/r/issues?q=label%3Adownload-report');
  });

  it('lists the last 30 days newest first and marks the day counting began', () => {
    const thirtyDays = text.slice(text.indexOf('## Last 30 days'), text.indexOf('## Week by week'));
    const rows = thirtyDays.split('\n').filter((line) => /^\| \w{3} \d+ \w{3} /.test(line));
    expect(rows).toHaveLength(30);
    expect(rows[0]).toMatch(/^\| Sun 7 Jun \| 9 \|/);
    expect(text).toContain('| Sun 24 May | 2\\* |');
    expect(text).toContain('\\* Counting started part-way through this day.');
  });

  it('shows how each week compared with the one before', () => {
    expect(text).toContain('| Mon 1 Jun 2026 | 42 | +12 |');
    expect(text).toContain('| Mon 25 May 2026 | 30 |  |');
    expect(text).toContain('| Mon 18 May 2026 (part) | 2 |  |');
    expect(text).not.toContain('11 May 2026');
  });

  it('mentions when the count had to be kept steady', () => {
    const dropped = ledgerOf([
      ['2026-06-01T00:10:00Z', 5],
      ['2026-06-02T00:10:00Z', 0],
    ]);
    expect(dashboard(dropped, 'o/r', at('2026-06-02T00:10:00Z'))).toContain('The count dropped on Tue 2 Jun 2026');
    expect(text).not.toContain('The count dropped');
  });
});

describe('the terminal report', () => {
  const full = dailyLedger('2026-05-24', 100, [2, 3, 4, 2, 5, 6, 1, 9, 5, 8, 0, 11, 3, 6, 9]);

  it('shows the totals, then the recent days, and ends with the weekly report', () => {
    const now = at('2026-06-08T15:00:00Z');
    const live = recordSnapshot(full, 174 + 4, now);
    const text = terminalReport(live, 'o/r', now);
    expect(text).toMatch(/Total\s+178\n/);
    expect(text).toMatch(/Today so far\s+4\n/);
    expect(text).toMatch(/Yesterday\s+9\n/);
    expect(text).toMatch(/Last 7 days\s+42\n/);
    expect(text).toMatch(/Last 30 days\s+74\n/);
    expect(text).toMatch(/Mon 8 Jun\s+4\s+#+\s+so far\n/);
    expect(text.indexOf('Last 14 days')).toBeLessThan(text.indexOf('Weekly report:'));
    const lines = text.trimEnd().split('\n');
    expect(lines.slice(-5)).toEqual([
      'Weekly report: Mon 1 Jun to Sun 7 Jun 2026',
      expect.stringMatching(/^ {2}Downloads\s+42 {2}\(up 12 from 30 the week before\)$/),
      expect.stringMatching(/^ {2}Best day\s+Thu 4 Jun, 11 downloads$/),
      expect.stringMatching(/^ {2}Average\s+6\.0 a day$/),
      expect.stringMatching(/^ {2}All time\s+178$/),
    ]);
    expect(text).not.toMatch(/[^\x20-\x7e\n]/);
  });

  it('says so when no week has finished yet', () => {
    const now = at('2026-06-03T18:00:00Z');
    const fresh = recordSnapshot(ledgerOf([['2026-06-03T14:30:00Z', 7]]), 9, now);
    const text = terminalReport(fresh, 'o/r', now);
    expect(text).toMatch(/Total\s+9\n/);
    expect(text).toMatch(/Today so far\s+2\n/);
    expect(text.trimEnd().split('\n').at(-1)).toBe('Weekly report: no finished week has been recorded yet.');
  });

  it('shows as many days as asked for', () => {
    const now = at('2026-06-08T15:00:00Z');
    const text = terminalReport(recordSnapshot(full, 174, now), 'o/r', now, 3);
    expect(text).toContain('Last 3 days');
    expect(text).toMatch(/Sat 6 Jun\s+6/);
    expect(text).not.toMatch(/Fri 5 Jun\s+3 /);
  });
});

describe('the command line', () => {
  const cleanups = [];
  afterEach(async () => {
    while (cleanups.length) await cleanups.pop()();
  });

  const temp = () => {
    const dir = mkdtempSync(join(tmpdir(), 'rf-stats-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  };

  /** A stand-in for api.github.com. */
  async function github({ releases = [], ledger = null, failFirst = false } = {}) {
    const seen = [];
    let failed = false;
    const server = createServer((req, res) => {
      seen.push({ url: req.url, accept: req.headers.accept, authorization: req.headers.authorization });
      if (failFirst && !failed) {
        failed = true;
        res.writeHead(502).end('bad gateway');
        return;
      }
      if (req.url.startsWith('/repos/o/r/releases')) {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(releases));
      } else if (req.url.startsWith('/repos/o/r/contents/downloads.json') && ledger !== null) {
        res.writeHead(200, { 'Content-Type': 'application/vnd.github.raw+json' }).end(ledger);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"message":"Not Found"}');
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(() => new Promise((resolve) => server.close(resolve)));
    return { url: `http://127.0.0.1:${server.address().port}`, seen };
  }

  const run = (args, { api, input } = {}) =>
    new Promise((resolve) => {
      const child = execFile(
        process.execPath,
        [SCRIPT, ...args],
        { env: { ...process.env, GITHUB_TOKEN: '', GH_TOKEN: '', GITHUB_REPOSITORY: 'o/r', ...(api ? { GITHUB_API_URL: api } : {}) } },
        (error, stdout, stderr) => resolve({ code: error ? error.code : 0, stdout, stderr }),
      );
      if (input !== undefined) child.stdin.end(input);
    });

  const live = (total) => [release(bankMarker(total - 3), apk(3))];

  it('banks the total of the release that is about to be replaced', async () => {
    const dir = temp();
    const file = join(dir, 'old-release.json');
    writeFileSync(file, JSON.stringify(release(bankMarker(10), apk(6))));
    expect((await run(['bank', file])).stdout).toBe(`${bankMarker(16)}\n`);
    expect((await run(['bank', '-'], { input: JSON.stringify(release(null, apk(2))) })).stdout).toBe(`${bankMarker(2)}\n`);
  });

  it('prints nothing to bank when it cannot read the release', async () => {
    const dir = temp();
    const file = join(dir, 'old-release.json');
    writeFileSync(file, 'not json');
    const result = await run(['bank', file]);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toMatch(/^Error: /);
  });

  it('starts a ledger on the first snapshot, then adds a line each day', async () => {
    const dir = temp();
    const ledger = join(dir, 'downloads.json');
    const out = join(dir, 'report');
    const api = await github({ releases: live(16) });
    const first = await run(['snapshot', '--ledger', ledger, '--out', out, '--now', '2026-06-03T14:30:00Z'], { api: api.url });
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('Total downloads: 16 (first snapshot)');
    expect(first.stdout).toContain('No finished week to report yet.');
    expect(parseLedger(readFileSync(ledger, 'utf8')).series).toEqual([{ t: '2026-06-03T14:30:00.000Z', total: 16 }]);
    expect(readFileSync(join(out, 'README.md'), 'utf8')).toContain('**16 downloads** of the Android app so far.');
    expect(existsSync(join(out, 'weekly.md'))).toBe(false);

    const next = await github({ releases: live(19) });
    const second = await run(['snapshot', '--ledger', ledger, '--out', out, '--now', '2026-06-04T00:10:00Z'], { api: next.url });
    expect(second.stdout).toContain('Total downloads: 19 (+3 since the last snapshot)');
    expect(parseLedger(readFileSync(ledger, 'utf8')).series.map((p) => p.total)).toEqual([16, 19]);
  });

  it('writes the weekly report for the week that just finished, and only then', async () => {
    const dir = temp();
    const ledger = join(dir, 'downloads.json');
    const out = join(dir, 'report');
    const perDay = [2, 3, 4, 2, 5, 6, 1, 9, 5, 8, 0, 11, 3, 6, 9];
    writeFileSync(ledger, serializeLedger(dailyLedger('2026-05-24', 100, perDay.slice(0, -1))));
    const api = await github({ releases: live(100 + perDay.reduce((a, b) => a + b, 0)) });
    const monday = await run(['snapshot', '--ledger', ledger, '--out', out, '--now', '2026-06-08T00:10:00Z'], { api: api.url });
    expect(monday.stdout).toContain('Weekly report: Weekly downloads: 2026-06-01 to 2026-06-07');
    expect(readFileSync(join(out, 'weekly-title.txt'), 'utf8')).toBe('Weekly downloads: 2026-06-01 to 2026-06-07\n');
    expect(readFileSync(join(out, 'weekly.md'), 'utf8')).toContain('**42 downloads** from Mon 1 Jun to Sun 7 Jun 2026, up 12 from 30 the week before.');

    // The same week is still the latest finished one on Wednesday, so the workflow can catch up if Monday was missed.
    const wednesday = await run(['snapshot', '--ledger', ledger, '--out', out, '--now', '2026-06-10T00:10:00Z'], { api: api.url });
    expect(wednesday.stdout).toContain('Weekly downloads: 2026-06-01 to 2026-06-07');
  });

  it('clears out an old weekly report when there is not a new one', async () => {
    const dir = temp();
    const out = join(dir, 'report');
    mkdirSync(out);
    writeFileSync(join(out, 'weekly.md'), 'old');
    writeFileSync(join(out, 'weekly-title.txt'), 'old');
    const api = await github({ releases: live(5) });
    await run(['snapshot', '--ledger', join(dir, 'downloads.json'), '--out', out, '--now', '2026-06-03T14:30:00Z'], { api: api.url });
    expect(existsSync(join(out, 'weekly.md'))).toBe(false);
    expect(existsSync(join(out, 'weekly-title.txt'))).toBe(false);
  });

  it('records nothing while the release is being replaced', async () => {
    const dir = temp();
    const ledger = join(dir, 'downloads.json');
    const api = await github({ releases: [] });
    const result = await run(['snapshot', '--ledger', ledger, '--out', join(dir, 'report'), '--now', '2026-06-03T14:30:00Z'], { api: api.url });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('nothing was recorded');
    expect(existsSync(ledger)).toBe(false);
  });

  it('stops rather than overwrite a ledger it cannot read', async () => {
    const dir = temp();
    const ledger = join(dir, 'downloads.json');
    writeFileSync(ledger, '{"oops":');
    const api = await github({ releases: live(5) });
    const result = await run(['snapshot', '--ledger', ledger, '--out', join(dir, 'report')], { api: api.url });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('is not valid JSON');
    expect(readFileSync(ledger, 'utf8')).toBe('{"oops":');
  });

  it('tries again when GitHub hiccups', async () => {
    const dir = temp();
    const api = await github({ releases: live(5), failFirst: true });
    const result = await run(['snapshot', '--ledger', join(dir, 'downloads.json'), '--out', join(dir, 'report')], { api: api.url });
    expect(result.code).toBe(0);
    expect(api.seen.filter((r) => r.url.startsWith('/repos/o/r/releases'))).toHaveLength(2);
  });

  it('reports the saved history plus the live count, ending with the weekly report', async () => {
    const full = dailyLedger('2026-05-24', 100, [2, 3, 4, 2, 5, 6, 1, 9, 5, 8, 0, 11, 3, 6, 9]);
    const api = await github({ releases: live(178), ledger: serializeLedger(full) });
    const result = await run(['report', '--now', '2026-06-08T15:00:00Z'], { api: api.url });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Total\s+178\n/);
    expect(result.stdout).toMatch(/Today so far\s+4\n/);
    expect(result.stdout.trimEnd().split('\n').at(-1)).toMatch(/All time\s+178$/);
    const read = api.seen.find((r) => r.url.startsWith('/repos/o/r/contents/downloads.json'));
    expect(read.url).toContain('ref=download-stats');
    expect(read.accept).toBe('application/vnd.github.raw+json');
  });

  it('reports from a ledger file when given one', async () => {
    const dir = temp();
    const file = join(dir, 'downloads.json');
    writeFileSync(file, serializeLedger(dailyLedger('2026-05-24', 100, [2, 3, 4, 2, 5, 6, 1, 9, 5, 8, 0, 11, 3, 6, 9])));
    const api = await github({ releases: live(174) });
    const result = await run(['report', '--ledger', file, '--days', '7', '--now', '2026-06-08T00:20:00Z'], { api: api.url });
    expect(result.stdout).toContain('Last 7 days\n');
    expect(result.stdout).toMatch(/Weekly report: Mon 1 Jun to Sun 7 Jun 2026/);
  });

  it('still gives the live total before any history has been saved', async () => {
    const api = await github({ releases: live(16) });
    const result = await run(['report'], { api: api.url });
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/Total\s+16\n/);
    expect(result.stdout).toContain('no daily history yet');
  });

  it('sends the token to GitHub when there is one, and no other secret', async () => {
    const api = await github({ releases: live(16) });
    await new Promise((resolve) => {
      execFile(process.execPath, [SCRIPT, 'report'], { env: { ...process.env, GITHUB_TOKEN: 'secret-token', GITHUB_REPOSITORY: 'o/r', GITHUB_API_URL: api.url } }, resolve);
    });
    expect(api.seen[0].authorization).toBe('Bearer secret-token');
  });

  it('explains itself when asked for something it does not do', async () => {
    const result = await run(['frobnicate']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Usage:');
  });
});
