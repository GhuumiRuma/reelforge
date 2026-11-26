/**
 * Platform-neutral value, time, color, scheduling, and file helpers.
 *
 * Most functions are pure. Browser/DOM-dependent helpers explicitly guard optional platform APIs
 * or keep failures best-effort so the editor, export UI, and native shell share one call site.
 */
/**
 * Generates a compact, locally unique ID from randomness and the current timestamp.
 * It is suitable for client persistence, not for cryptographic/security-sensitive identifiers.
 */
export const uid = (prefix = '') =>
  prefix + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-5);

/** Clamps `v` to the closed interval `[a, b]`. */
export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
/** Linearly interpolates between numeric endpoints; `t` is not clamped. */
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Cubic ease-in/ease-out curve for normalized animation progress. */
export const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
/** Cubic ease-out curve for normalized animation progress. */
export const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
/** Overshooting cubic back-out curve for normalized UI animation progress. */
export const backOut = (t: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

/**
 * Formats timeline seconds as zero-padded minutes/seconds, optionally with floor-truncated tenths.
 * Non-finite and negative values display as zero; integer tenths avoid floating-point drift.
 */
export function formatTime(s: number, frac = false): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  // Integer tenths avoid float drift (2.3 - 2 = 0.2999…).
  const tenths = Math.floor(s * 10 + 1e-6);
  const whole = Math.floor(tenths / 10);
  const mm = String(Math.floor(whole / 60)).padStart(2, '0');
  const ss = String(whole % 60).padStart(2, '0');
  return frac ? `${mm}:${ss}.${tenths % 10}` : `${mm}:${ss}`;
}

/** Like formatTime with tenths, but keeps hundredths when they matter ("00:42.55"). Pairs with parseTime. */
export function formatClock(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  const cs = Math.round(s * 100);
  const whole = Math.floor(cs / 100);
  const mm = String(Math.floor(whole / 60)).padStart(2, '0');
  const ss = String(whole % 60).padStart(2, '0');
  const frac = cs % 100;
  return `${mm}:${ss}.${frac % 10 ? String(frac).padStart(2, '0') : frac / 10}`;
}

/**
 * Reads a typed time: seconds ("42.5", "42,5", "42s"), minutes:seconds ("0:42.5", "1:02") or
 * hours:minutes:seconds ("1:02:03"). Phone number pads have no colon, so from 100 up the last two
 * digits are seconds, like on a microwave: "102.5" is 1:02.5. Returns null when the text isn't a time.
 */
export function parseTime(text: string): number | null {
  const s = text.trim().replace(',', '.');
  const secs = /^(\d+(?:\.\d*)?|\.\d+)s$/i.exec(s);
  if (secs) return Number(secs[1]);
  const pad = /^(\d*)(\.\d*)?$/.exec(s);
  if (pad) {
    const [, whole, frac = ''] = pad;
    if (!whole && frac.length < 2) return null;
    if (whole.length <= 2) return Number(`${whole || 0}${frac}`);
    const sec = Number(whole.slice(-2) + frac);
    return sec >= 60 ? null : Number(whole.slice(0, -2)) * 60 + sec;
  }
  const m = /^(?:(\d+):)?(\d+):(\d{1,2}(?:\.\d*)?)$/.exec(s);
  if (!m) return null;
  const [, h, min, sec] = m;
  if (Number(sec) >= 60 || (h !== undefined && Number(min) >= 60)) return null;
  return Number(h ?? 0) * 3600 + Number(min) * 60 + Number(sec);
}

/** Formats short durations in seconds and longer values with the editor's clock formatter. */
export function formatDuration(s: number): string {
  if (!Number.isFinite(s) || s < 0) s = 0;
  // Tenths are truncated like formatTime so this matches the editor's timer.
  const tenths = Math.floor(s * 10 + 1e-6);
  if (tenths < 100) return `${(tenths / 10).toFixed(1)}s`;
  const whole = Math.round(s);
  return whole < 60 ? `${whole}s` : formatTime(whole);
}

/** Formats a byte count with binary KB/MB/GB units; invalid and non-positive counts show `0 B`. */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i >= 2 ? 1 : 0)} ${u[i]}`;
}

/** Locale-aware relative formatter, or `null` on runtimes without `Intl.RelativeTimeFormat`. */
const rtf = typeof Intl !== 'undefined' && 'RelativeTimeFormat' in Intl ? new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }) : null;

/** "3 hours ago", "yesterday"; a date once it is more than a month back. */
export function ago(ts: number): string {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  const steps: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, 'minute'],
    [3600, 'hour'],
    [86400, 'day'],
    [604800, 'week'],
  ];
  if (s >= 2592000) return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  let unit = steps[0];
  for (const st of steps) if (s >= st[0]) unit = st;
  const n = Math.floor(s / unit[0]);
  return rtf ? rtf.format(-n, unit[1]) : `${n} ${unit[1]}${n === 1 ? '' : 's'} ago`;
}

/**
 * Converts short/long CSS hex to floating RGB channels in 0–1.
 * Invalid numeric input returns white because this helper is used on trusted UI theme colors.
 */
export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace('#', '').trim();
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h.slice(0, 6), 16);
  if (Number.isNaN(n)) return [1, 1, 1];
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** Converts a CSS hex color to comma-form `rgba(...)` with a caller-provided alpha. */
export function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a})`;
}

/**
 * Returns a trailing-edge debounced function plus a `.flush(args)` method.
 * Calling or flushing after a pending timer clears it; the most recent callback arguments win.
 */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wrapped = (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, ms);
  };
  wrapped.flush = (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    fn(...args);
  };
  return wrapped;
}

/** Device detection for iOS, including iPadOS browsers that report a Macintosh desktop user agent. */
export const isIOS = (() => {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
})();

/** User-agent check for Android-specific browser behavior, safely false during SSR/tests. */
export const isAndroid = typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);

/** Reports whether the page runs as an installed standalone PWA or iOS home-screen app. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/** Resolves on the next animation frame, yielding control before another paint. */
export function nextFrame(): Promise<void> {
  return new Promise((r) => requestAnimationFrame(() => r()));
}

/** Promise-based delay that does not block the browser main thread. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Rounds a pixel dimension to the nearest even value, never below two. */
export function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

/** Deep-clones structured data, transferring no references and requiring `structuredClone` support. */
export function deepClone<T>(v: T): T {
  return structuredClone(v);
}

/** Whether this is running inside the Android app rather than a browser. */
export function isNativeApp(): boolean {
  return typeof window !== 'undefined' && !!(window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();
}

/**
 * Saves a blob through the platform-appropriate file path.
 *
 * Android uses a dynamically imported Capacitor filesystem adapter and reports toast status;
 * browsers synthesize a download link and revoke its object URL after one minute. Neither path
 * uploads the blob to a server.
 */
export function downloadBlob(blob: Blob, name: string) {
  if (isNativeApp()) {
    // The app's web view can't download files, so save them to Documents/ReelForge instead.
    void Promise.all([import('./native'), import('../state/store')]).then(([native, store]) =>
      native.nativeSave(blob, name).then(
        (where) => store.toast(`Saved to ${where}`, 'success'),
        (e) => {
          console.error('Saving failed', e);
          store.toast('Could not save the file. Check the phone has space.', 'error');
        },
      ),
    );
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/**
 * A name that's safe to save on any phone or computer. Keeps spaces, accents and emoji;
 * only removes the characters file systems reject.
 */
export function safeFileName(name: string, fallback = 'video'): string {
  const s = name
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  return Array.from(s).slice(0, 80).join('').trim() || fallback;
}
