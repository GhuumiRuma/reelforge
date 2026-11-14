/**
 * Glue for the Android app (Capacitor). In a browser every function here falls back to the web
 * behavior, so the same build runs everywhere.
 */
import { Capacitor, CapacitorHttp, SystemBars, SystemBarsStyle } from '@capacitor/core';
import type { SocialNet } from './social';

export const isNative = (): boolean => Capacitor.isNativePlatform();

/**
 * Colors the status and navigation bar icons for the app's theme: light icons over the dark app,
 * dark icons over the light one. Left alone they follow the phone's own setting, which can disagree.
 */
export async function nativeSystemBars(theme: 'light' | 'dark'): Promise<void> {
  if (!isNative()) return;
  await SystemBars.setStyle({ style: theme === 'light' ? SystemBarsStyle.Light : SystemBarsStyle.Dark });
}

function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/**
 * fetch() through the phone's own networking, which isn't limited by browser CORS rules.
 * Only used in the Android app; request bodies must be text (JSON, form data as a string).
 */
export async function nativeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const req = new Request(input, init);
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => (headers[k] = v));
  // A WebView Request quietly drops headers that browsers set themselves, like User-Agent and Referer.
  // The phone's networking can send them, and YouTube and TikTok check them. Cookies are left to the
  // phone's cookie jar, which keeps them between requests as a browser would.
  if (init?.headers)
    new Headers(init.headers).forEach((v, k) => {
      if (k !== 'cookie') headers[k] = v;
    });
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.text();
  if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const res = await CapacitorHttp.request({
    url: req.url,
    method: req.method,
    headers,
    data: body || undefined,
    responseType: 'arraybuffer',
    shouldEncodeUrlParams: false,
    connectTimeout: 20_000,
    readTimeout: 60_000,
  });
  if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  // Asked for an arraybuffer, CapacitorHttp sends the body as base64, except error bodies and anything
  // labelled JSON: those come back as text, parsed when it is valid JSON. Some of YouTube's JSON starts
  // with ")]}'", so it stays text.
  const contentType = Object.entries(res.headers ?? {}).find(([k]) => k.toLowerCase() === 'content-type')?.[1] ?? '';
  const text = res.status >= 400 || String(contentType).includes('application/json');
  const data: unknown = res.data;
  const bytes =
    typeof data === 'string'
      ? text
        ? new TextEncoder().encode(data)
        : fromBase64(data)
      : data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new TextEncoder().encode(typeof data === 'object' ? JSON.stringify(data) : String(data ?? ''));
  const nullBody = res.status === 204 || res.status === 304 || req.method === 'HEAD';
  const response = new Response(nullBody ? null : bytes, { status: res.status, headers: res.headers });
  Object.defineProperty(response, 'url', { value: res.url || req.url });
  return response;
}

/** fetch() that works for any http(s) link: native in the app, normal fetch in a browser. */
export function anyFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return isNative() ? nativeFetch(input, init) : fetch(input, init);
}

/**
 * Networking for TikTok and Instagram downloads in the Android app. Android keeps cookies between
 * requests on its own (Capacitor installs a cookie manager), as a browser would.
 */
export const nativeNet: SocialNet = {
  async text(url, init = {}) {
    if (!isNative()) throw new TypeError('Only the Android app can reach this site.');
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const res = await CapacitorHttp.request({
      url,
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      data: init.body,
      responseType: 'text',
      shouldEncodeUrlParams: false,
      connectTimeout: 20_000,
      readTimeout: 60_000,
    });
    if (init.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers ?? {})) headers[k.toLowerCase()] = String(v);
    const data: unknown = res.data;
    return { status: res.status, url: res.url || url, headers, text: typeof data === 'string' ? data : JSON.stringify(data ?? '') };
  },
  bytes: (url, init = {}) => nativeFetch(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal }),
};

/** Bytes per write when handing files to the native side (base64 grows them by a third). */
const WRITE_CHUNK = 3 * 1024 * 1024;

/** For writes that can take minutes, like a backup of a whole library. */
export interface WriteOptions {
  /** called after each piece with the bytes written so far */
  onProgress?: (written: number) => void;
  /** stops the write and removes the part-written file */
  signal?: AbortSignal;
}

async function writeNative(blob: Blob, path: string, directory: 'cache' | 'documents', opts: WriteOptions = {}): Promise<string> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  const dir = directory === 'cache' ? Directory.Cache : Directory.Documents;
  const stopIfCancelled = () => {
    if (opts.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
  };
  try {
    for (let off = 0; off < Math.max(1, blob.size); off += WRITE_CHUNK) {
      stopIfCancelled();
      const data = toBase64(new Uint8Array(await blob.slice(off, off + WRITE_CHUNK).arrayBuffer()));
      if (off === 0) await Filesystem.writeFile({ path, data, directory: dir, recursive: true });
      else await Filesystem.appendFile({ path, data, directory: dir });
      opts.onProgress?.(Math.min(blob.size, off + WRITE_CHUNK));
    }
    stopIfCancelled();
  } catch (e) {
    // A file that stops part-way would sit there looking like a finished one.
    await Filesystem.deleteFile({ path, directory: dir }).catch(() => undefined);
    throw e;
  }
  return (await Filesystem.getUri({ path, directory: dir })).uri;
}

/** Share copies older than this are removed the next time something is shared. */
const SHARE_COPY_KEEP_MS = 24 * 60 * 60 * 1000;

/**
 * The share sheet needs a copy of the file in the app's cache, and the app that receives it may still be
 * reading that copy long after the sheet closes, so it can't be deleted straight away. Old copies are
 * cleared before the next share instead, which matters because a backup can be gigabytes.
 */
async function removeOldShareCopies(): Promise<void> {
  const { Filesystem, Directory } = await import('@capacitor/filesystem');
  try {
    const { files } = await Filesystem.readdir({ path: 'share', directory: Directory.Cache });
    const cutoff = Date.now() - SHARE_COPY_KEEP_MS;
    await Promise.all(
      files
        .filter((f) => f.type === 'file' && f.mtime < cutoff)
        .map((f) => Filesystem.deleteFile({ path: `share/${f.name}`, directory: Directory.Cache }).catch(() => undefined)),
    );
  } catch {
    // Nothing has been shared yet, or the folder can't be listed. Sharing still works.
  }
}

/** Opens the Android share sheet for a file. */
export async function nativeShare(file: File, title: string, opts?: WriteOptions): Promise<'shared' | 'cancelled'> {
  const { Share } = await import('@capacitor/share');
  await removeOldShareCopies();
  const uri = await writeNative(file, `share/${file.name}`, 'cache', opts);
  try {
    await Share.share({ title, files: [uri], dialogTitle: title });
    return 'shared';
  } catch (e) {
    if (/cancel/i.test(String((e as Error)?.message ?? e))) return 'cancelled';
    throw e;
  }
}

/** Saves a file to Documents/ReelForge on the phone and returns where it went. */
export async function nativeSave(blob: Blob, name: string, opts?: WriteOptions): Promise<string> {
  await writeNative(blob, `ReelForge/${name}`, 'documents', opts);
  return `Documents/ReelForge/${name}`;
}
