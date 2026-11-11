// Counts how many times the ReelForge Android app has been downloaded from GitHub and reports it.
//
//   node scripts/download-stats.mjs report          total, daily numbers and the last finished week
//   node scripts/download-stats.mjs snapshot ...    what the "Download stats" workflow runs every day
//   node scripts/download-stats.mjs bank [file]     what the Android workflow runs before it replaces the release
//
// GitHub only keeps a running total for each release file, and the Android workflow replaces the release on
// every build, which starts that total again at zero. Two things make the numbers last:
//  - Banking: before the release is replaced, its total is written into the new release's notes as an
//    invisible <!-- rf-banked-downloads:N --> comment, so a release's downloads are always its banked
//    count plus the live count of its APK.
//  - A ledger of snapshots (downloads.json on the download-stats branch) that the daily numbers are worked
//    out from. Days are UTC and the snapshot runs just after midnight, so each day's count is exact.
//
// No dependencies, so the workflows can run it straight after checkout.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const LEDGER_BRANCH = 'download-stats';
export const LEDGER_FILE = 'downloads.json';
export const REPORT_LABEL = 'download-report';

const DAY = 86_400_000;
const WEEK = 7 * DAY;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const sum = (numbers) => numbers.reduce((a, b) => a + b, 0);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const whole = (n) => Number.isSafeInteger(n) && n >= 0;

// ---------------------------------------------------------------------------------------------
// Counting downloads
// ---------------------------------------------------------------------------------------------

const MARKER = /<!--\s*rf-banked-downloads:(\d+)\s*-->/;

export const bankMarker = (n) => `<!-- rf-banked-downloads:${n} -->`;

/** The count a release's notes carry over from the releases it replaced. */
export function readBanked(notes) {
  const found = typeof notes === 'string' ? MARKER.exec(notes) : null;
  const n = found ? Number(found[1]) : 0;
  return whole(n) ? n : 0;
}

const isApk = (asset) => typeof asset?.name === 'string' && asset.name.toLowerCase().endsWith('.apk');

/** What one release has been downloaded: the count banked from replaced builds plus its APK's live count. */
export function releaseDownloads(release) {
  const apks = Array.isArray(release?.assets) ? release.assets.filter(isApk) : [];
  return {
    banked: readBanked(release?.body),
    live: sum(apks.map((asset) => (whole(asset.download_count) ? asset.download_count : 0))),
    apks: apks.length,
  };
}

/** Every published release together. `found` is false when there is no APK to count, e.g. mid-build. */
export function totalDownloads(releases) {
  let total = 0;
  let found = false;
  for (const release of releases) {
    if (!release || release.draft) continue;
    const { banked, live, apks } = releaseDownloads(release);
    if (apks === 0 && banked === 0) continue;
    found = true;
    total += banked + live;
  }
  return { total, found };
}

// ---------------------------------------------------------------------------------------------
// The ledger: the running total, sampled
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {{ t: string, total: number }} Snapshot       when it was taken, and the total at that moment
 * @typedef {{ version: 1, offset: number, last: number, adjustments: { t: string, added: number }[], series: Snapshot[] }} Ledger
 *   `last` is the latest raw count from GitHub and `offset` what was added to keep the total from dropping
 */

export const emptyLedger = () => ({ version: 1, offset: 0, last: 0, adjustments: [], series: [] });

const iso = (ms) => new Date(ms).toISOString();

/** @returns {Ledger} */
export function parseLedger(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${LEDGER_FILE} is not valid JSON.`);
  }
  const adjustments = data?.adjustments ?? [];
  if (data?.version !== 1 || !whole(data.offset) || !whole(data.last) || !Array.isArray(data.series) || !Array.isArray(adjustments)) {
    throw new Error(`${LEDGER_FILE} is not a download ledger.`);
  }
  let before = -Infinity;
  const series = data.series.map((point) => {
    const t = Date.parse(point?.t);
    if (!Number.isFinite(t) || t < before || !whole(point.total)) {
      throw new Error(`${LEDGER_FILE} has a bad snapshot: ${JSON.stringify(point)}`);
    }
    before = t;
    return { t: iso(t), total: point.total };
  });
  return {
    version: 1,
    offset: data.offset,
    last: data.last,
    adjustments: adjustments.filter((a) => typeof a?.t === 'string' && whole(a.added)).map((a) => ({ t: a.t, added: a.added })),
    series,
  };
}

/** One line per snapshot, so each day adds a single line to the diff. */
export function serializeLedger(ledger) {
  const points = ledger.series.map((point) => `    ${JSON.stringify(point)}`).join(',\n');
  return [
    '{',
    `  "version": ${ledger.version},`,
    `  "offset": ${ledger.offset},`,
    `  "last": ${ledger.last},`,
    `  "adjustments": ${JSON.stringify(ledger.adjustments)},`,
    '  "series": [',
    points,
    '  ]',
    '}',
    '',
  ].join('\n');
}

/**
 * Adds a snapshot of GitHub's raw total. If that total dropped (the release was replaced without its count
 * being carried over) the drop is made up so the running total never goes backwards.
 * @param {Ledger} ledger
 * @returns {Ledger}
 */
export function recordSnapshot(ledger, raw, atMs) {
  const latest = ledger.series[ledger.series.length - 1];
  const t = latest ? Math.max(atMs, Date.parse(latest.t)) : atMs;
  let { offset } = ledger;
  const adjustments = ledger.adjustments.slice();
  if (raw < ledger.last) {
    const added = ledger.last - raw;
    offset += added;
    adjustments.push({ t: iso(t), added });
  }
  return { ...ledger, offset, last: raw, adjustments, series: [...ledger.series, { t: iso(t), total: raw + offset }] };
}

// ---------------------------------------------------------------------------------------------
// Days and weeks (UTC)
// ---------------------------------------------------------------------------------------------

export const startOfDay = (ms) => Math.floor(ms / DAY) * DAY;

/** Monday 00:00 UTC of the week that contains `ms`. */
export const startOfWeek = (ms) => {
  const day = startOfDay(ms);
  return day - ((new Date(day).getUTCDay() + 6) % 7) * DAY;
};

/** Monday 00:00 UTC of the most recent week that has finished. */
export const lastFullWeek = (ms) => startOfWeek(ms) - WEEK;

/** The running total at an instant, worked out between the snapshots either side of it. Null outside the recorded range. */
export function totalAt(series, ms) {
  const times = series.map((point) => Date.parse(point.t));
  if (times.length === 0 || ms < times[0] || ms > times[times.length - 1]) return null;
  let i = times.length - 1;
  while (times[i] > ms) i--;
  if (i === times.length - 1 || times[i] === ms) return series[i].total;
  const share = (ms - times[i]) / (times[i + 1] - times[i]);
  return series[i].total + (series[i + 1].total - series[i].total) * share;
}

/** Downloads between two instants, cut to the recorded range. `partial` says it was cut. Null when nothing was recorded. */
export function downloadsBetween(series, from, to) {
  if (series.length === 0) return null;
  const start = Math.max(from, Date.parse(series[0].t));
  const end = Math.min(to, Date.parse(series[series.length - 1].t));
  if (end <= start) return null;
  return {
    n: Math.round(totalAt(series, end)) - Math.round(totalAt(series, start)),
    partial: start > from || end < to,
  };
}

/** @returns {{ day: number, n: number | null, partial: boolean }[]} `days` consecutive UTC days from `firstDay`. */
export function dailyCounts(series, firstDay, days) {
  return Array.from({ length: days }, (_, i) => {
    const day = firstDay + i * DAY;
    const counted = downloadsBetween(series, day, day + DAY);
    return { day, n: counted ? counted.n : null, partial: counted ? counted.partial : false };
  });
}

const sumKnown = (days) => sum(days.map((d) => d.n ?? 0));

/** One Monday-to-Sunday week. `complete` means all seven days were recorded in full. */
export function weekSummary(series, weekStart) {
  const days = dailyCounts(series, weekStart, 7);
  const known = days.filter((d) => d.n !== null);
  const total = sumKnown(known);
  return {
    start: weekStart,
    days,
    known: known.length,
    total,
    complete: known.length === 7 && known.every((d) => !d.partial),
    best: known.length ? known.reduce((best, d) => (d.n > best.n ? d : best)) : null,
    average: known.length ? total / known.length : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------------------------

function dayName(ms) {
  const d = new Date(ms);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
const dayNameYear = (ms) => `${dayName(ms)} ${new Date(ms).getUTCFullYear()}`;
const clock = (ms) => `${iso(ms).slice(11, 16)} UTC`;
const isoDay = (ms) => iso(ms).slice(0, 10);
const signed = (n) => (n > 0 ? `+${n}` : String(n));

function bar(n, max, mark, width) {
  if (!n || !max) return '';
  return mark.repeat(Math.max(1, Math.round((n / max) * width)));
}

function comparison(week, previous) {
  if (!week.complete || !previous.complete) return '';
  const change = week.total - previous.total;
  if (change === 0) return `the same as the week before (${previous.total})`;
  return `${change > 0 ? 'up' : 'down'} ${Math.abs(change)} from ${previous.total} the week before`;
}

function dayTable(days, total) {
  const max = Math.max(0, ...days.map((d) => d.n ?? 0));
  const cell = (d) => (d.n === null ? '–' : `${d.n}${d.partial ? '\\*' : ''}`);
  return [
    '| Day | Downloads | |',
    '| --- | ---: | --- |',
    ...days.map((d) => `| ${dayName(d.day)} | ${cell(d)} | ${bar(d.n, max, '█', 24)} |`),
    ...(total === undefined ? [] : [`| **Total** | **${total}** | |`]),
  ].join('\n');
}

const reportsLink = (repo) => `https://github.com/${repo}/issues?q=label%3A${REPORT_LABEL}`;
const dashboardLink = (repo) => `https://github.com/${repo}/tree/${LEDGER_BRANCH}`;

/**
 * The issue the workflow opens for a finished week. Null when nothing was recorded in that week.
 * @param {Ledger} ledger
 */
export function weeklyReport(ledger, repo, weekStart) {
  const { series } = ledger;
  if (series.length === 0) return null;
  const week = weekSummary(series, weekStart);
  if (week.known === 0) return null;
  const previous = weekSummary(series, weekStart - WEEK);
  const lastDay = weekStart + 6 * DAY;
  const first = Date.parse(series[0].t);
  const latest = series[series.length - 1];
  const against = comparison(week, previous);
  const body = [
    `**${plural(week.total, 'download')}** from ${dayName(weekStart)} to ${dayNameYear(lastDay)}${against ? `, ${against}` : ''}.`,
    '',
    dayTable(week.days, week.total),
    '',
    `- **Best day:** ${dayName(week.best.day)}, ${plural(week.best.n, 'download')}`,
    `- **Average:** ${week.average.toFixed(1)} a day`,
    `- **All-time total:** ${plural(latest.total, 'download')}, as of ${dayNameYear(Date.parse(latest.t))} at ${clock(Date.parse(latest.t))}`,
    '',
    ...(week.complete
      ? []
      : [`Counting started on ${dayNameYear(first)} at ${clock(first)}, so the days before it are blank and a day that is cut short is marked \\*.`, '']),
    `Days run from midnight to midnight UTC. GitHub counts every completed download of the APK, so repeat downloads and your own count too. The running numbers are on the [${LEDGER_BRANCH} branch](${dashboardLink(repo)}).`,
  ].join('\n');
  return { title: `Weekly downloads: ${isoDay(weekStart)} to ${isoDay(lastDay)}`, body };
}

/** Finished weeks that have any numbers, newest first. */
function weekHistory(series, nowMs, weeks) {
  const first = Date.parse(series[0].t);
  const rows = [];
  for (let k = 0; k < weeks; k++) {
    const start = lastFullWeek(nowMs) - k * WEEK;
    if (start + WEEK <= first) break;
    const week = weekSummary(series, start);
    if (week.known === 0) continue;
    const before = weekSummary(series, start - WEEK);
    rows.push({ week, change: week.complete && before.complete ? week.total - before.total : null });
  }
  return rows;
}

/**
 * The README on the stats branch.
 * @param {Ledger} ledger
 */
export function dashboard(ledger, repo, nowMs) {
  const { series } = ledger;
  const first = Date.parse(series[0].t);
  const latest = series[series.length - 1];
  const today = startOfDay(nowMs);
  const month = dailyCounts(series, today - 30 * DAY, 30);
  const yesterday = month[month.length - 1];
  const history = weekHistory(series, nowMs, 12);
  const dropped = ledger.adjustments[ledger.adjustments.length - 1];
  return [
    '# ReelForge download stats',
    '',
    `**${plural(latest.total, 'download')}** of the Android app so far.`,
    '',
    '| Yesterday | Last 7 days | Last 30 days |',
    '| ---: | ---: | ---: |',
    `| ${yesterday.n ?? '–'} | ${sumKnown(month.slice(-7))} | ${sumKnown(month)} |`,
    '',
    `Counting since ${dayNameYear(first)}${first > today - 30 * DAY ? ', so the longer periods only cover the days since then' : ''}. Updated ${dayNameYear(Date.parse(latest.t))} at ${clock(Date.parse(latest.t))}. Days run from midnight to midnight UTC. Each finished week is also posted as an [issue](${reportsLink(repo)}).`,
    '',
    '## Last 30 days',
    '',
    dayTable(month.slice().reverse()),
    ...(month.some((d) => d.partial) ? ['', '\\* Counting started part-way through this day.'] : []),
    '',
    ...(history.length
      ? [
          '## Week by week',
          '',
          '| Week | Downloads | Change |',
          '| --- | ---: | ---: |',
          ...history.map(({ week, change }) => `| ${dayNameYear(week.start)}${week.complete ? '' : ' (part)'} | ${week.total} | ${change === null ? '' : signed(change)} |`),
          '',
        ]
      : []),
    ...(dropped
      ? [`The count dropped on ${dayNameYear(Date.parse(dropped.t))} because the release was replaced without carrying its downloads over, so ${dropped.added} was added to keep the total steady.`, '']
      : []),
  ].join('\n');
}

/**
 * Plain text for the terminal: the totals, the recent days, and the last finished week at the end.
 * @param {Ledger} ledger
 */
export function terminalReport(ledger, repo, nowMs, days = 14) {
  const { series } = ledger;
  const first = Date.parse(series[0].t);
  const today = startOfDay(nowMs);
  const recent = dailyCounts(series, today - (days - 1) * DAY, days);
  const month = dailyCounts(series, today - 30 * DAY, 30);
  const shown = (d) => (d.n === null ? '-' : String(d.n));
  const stat = (label, value) => `  ${label.padEnd(14)}${String(value).padStart(7)}`;
  const entry = (label, value) => `  ${label.padEnd(14)}${value}`;
  const max = Math.max(0, ...recent.map((d) => d.n ?? 0));
  const week = weekSummary(series, lastFullWeek(nowMs));
  const lines = [
    `ReelForge Android app downloads (${repo})`,
    `Counting since ${dayNameYear(first)} at ${clock(first)}. Days are UTC.`,
    '',
    stat('Total', series[series.length - 1].total),
    stat('Today so far', shown(recent[recent.length - 1])),
    stat('Yesterday', shown(month[month.length - 1])),
    stat('Last 7 days', sumKnown(month.slice(-7))),
    stat('Last 30 days', sumKnown(month)),
    '',
    `Last ${days} days`,
    ...recent.map((d, i) => {
      const note = d.partial ? (i === recent.length - 1 ? '  so far' : '  part of the day') : '';
      return `  ${dayName(d.day).padEnd(11)}${shown(d).padStart(5)}  ${bar(d.n, max, '#', 30)}${note}`.trimEnd();
    }),
    '',
  ];
  if (week.known === 0) {
    lines.push(`Weekly report: no finished week has been recorded yet.`);
  } else {
    const against = comparison(week, weekSummary(series, week.start - WEEK));
    lines.push(
      `Weekly report: ${dayName(week.start)} to ${dayNameYear(week.start + 6 * DAY)}`,
      entry('Downloads', week.total + (against ? `  (${against})` : '')),
      entry('Best day', `${dayName(week.best.day)}, ${plural(week.best.n, 'download')}`),
      entry('Average', `${week.average.toFixed(1)} a day`),
      entry('All time', series[series.length - 1].total),
      ...(week.complete ? [] : [`  (Counting started part-way through this week, so it covers ${plural(week.known, 'day')}.)`]),
    );
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------------------------

async function request(path, accept = 'application/vnd.github+json') {
  const base = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const headers = { Accept: accept, 'User-Agent': 'reelforge-download-stats', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${base}${path}`, { headers });
      if ((res.status < 500 && res.status !== 429) || attempt === 3) return res;
    } catch (error) {
      if (attempt === 3) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
  }
}

async function fetchReleases(repo) {
  const releases = [];
  for (let page = 1; page <= 20; page++) {
    const res = await request(`/repos/${repo}/releases?per_page=100&page=${page}`);
    if (!res.ok) throw new Error(`GitHub answered ${res.status} when listing the releases of ${repo}.`);
    const batch = await res.json();
    if (!Array.isArray(batch)) throw new Error('GitHub sent back something other than a list of releases.');
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  return releases;
}

/** The saved ledger from the stats branch, or null when the branch doesn't exist yet. */
async function fetchLedger(repo) {
  const res = await request(`/repos/${repo}/contents/${LEDGER_FILE}?ref=${LEDGER_BRANCH}`, 'application/vnd.github.raw+json');
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub answered ${res.status} when reading ${LEDGER_FILE} from the ${LEDGER_BRANCH} branch.`);
  return parseLedger(await res.text());
}

function detectRepo(given) {
  const repo = given || process.env.GITHUB_REPOSITORY;
  if (repo) return repo;
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const found = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
    if (found) return found[1];
  } catch {
    // Not a git checkout; fall through to the error below.
  }
  throw new Error('Could not tell which repository to look at. Pass --repo owner/name.');
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

const USAGE = `Usage:
  node scripts/download-stats.mjs report [--repo owner/name] [--days 14] [--ledger file]
  node scripts/download-stats.mjs snapshot --ledger file --out dir [--repo owner/name]
  node scripts/download-stats.mjs bank [release.json]`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      args._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 0) args[arg.slice(2, eq)] = arg.slice(eq + 1);
    else args[arg.slice(2)] = argv[++i];
  }
  return args;
}

function readNow(args) {
  const now = args.now ? Date.parse(args.now) : Date.now();
  if (!Number.isFinite(now)) throw new Error(`--now is not a date: ${args.now}`);
  return now;
}

/** Prints the banked-count comment for the release that is about to replace this one. */
function bank(args) {
  const [file] = args._;
  const release = JSON.parse(file && file !== '-' ? readFileSync(file, 'utf8') : readFileSync(0, 'utf8'));
  const { banked, live } = releaseDownloads(release);
  console.log(bankMarker(banked + live));
}

async function snapshot(args) {
  if (!args.ledger || !args.out) throw new Error('snapshot needs --ledger <file> and --out <dir>.');
  const repo = detectRepo(args.repo);
  const now = readNow(args);
  const live = totalDownloads(await fetchReleases(repo));
  if (!live.found) {
    console.log('No APK release is published right now (a new build may be replacing it), so nothing was recorded.');
    return;
  }
  const saved = existsSync(args.ledger) ? parseLedger(readFileSync(args.ledger, 'utf8')) : emptyLedger();
  const ledger = recordSnapshot(saved, live.total, now);
  const total = ledger.series[ledger.series.length - 1].total;
  const previous = saved.series[saved.series.length - 1];
  writeFileSync(args.ledger, serializeLedger(ledger));
  mkdirSync(args.out, { recursive: true });
  for (const name of ['weekly.md', 'weekly-title.txt']) rmSync(join(args.out, name), { force: true });
  writeFileSync(join(args.out, 'README.md'), dashboard(ledger, repo, now));
  console.log(`Total downloads: ${total}${previous ? ` (${signed(total - previous.total)} since the last snapshot)` : ' (first snapshot)'}`);
  const weekly = weeklyReport(ledger, repo, lastFullWeek(now));
  if (!weekly) {
    console.log('No finished week to report yet.');
    return;
  }
  writeFileSync(join(args.out, 'weekly.md'), `${weekly.body}\n`);
  writeFileSync(join(args.out, 'weekly-title.txt'), `${weekly.title}\n`);
  console.log(`Weekly report: ${weekly.title}`);
}

async function report(args) {
  const repo = detectRepo(args.repo);
  const now = readNow(args);
  const days = Math.min(90, Math.max(1, Math.floor(Number(args.days ?? 14)) || 14));
  const live = totalDownloads(await fetchReleases(repo));
  if (!live.found) throw new Error(`${repo} has no published APK release to count.`);
  const saved = args.ledger ? parseLedger(readFileSync(args.ledger, 'utf8')) : await fetchLedger(repo);
  if (!saved) {
    console.log(`ReelForge Android app downloads (${repo})\n\n  Total  ${live.total}\n`);
    console.log(
      `There is no daily history yet. The "Download stats" workflow starts it (it has to be on the main branch first), and it saves the history on the ${LEDGER_BRANCH} branch.`,
    );
    return;
  }
  process.stdout.write(terminalReport(recordSnapshot(saved, live.total, now), repo, now, days));
}

export async function main(argv) {
  const [command, ...rest] = argv;
  const args = parseArgs(rest);
  if (command === 'bank') return bank(args);
  if (command === 'snapshot') return snapshot(args);
  if (command === 'report') return report(args);
  console.error(USAGE);
  process.exitCode = command ? 2 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
  });
}
