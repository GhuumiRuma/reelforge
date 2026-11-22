import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerHostNetwork, type HostRequest, type HostResponse } from './hostNetwork';
import { anyFetch, nativeNet } from './native';
import { canUseYouTubeApi } from './youtube';

const bytes = (...values: number[] | string[]) => (typeof values[0] === 'string' ? new TextEncoder().encode(values.join('')) : new Uint8Array(values as number[]));

function stream(...chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}

/** Registers a host that notes each request and answers with the reply, which can differ per request. */
function fakeHost(reply: (req: HostRequest) => Partial<HostResponse> = () => ({})) {
  const seen: { req: HostRequest; signal?: AbortSignal }[] = [];
  registerHostNetwork({
    async request(req, signal) {
      seen.push({ req, signal });
      return { status: 200, statusText: 'OK', url: req.url, headers: {}, body: stream(), ...reply(req) };
    },
  });
  return seen;
}

afterEach(() => {
  registerHostNetwork(undefined);
  vi.unstubAllGlobals();
});

describe('networking through the app that hosts ReelForge', () => {
  it('hands the host the method, headers and text body as plain data, including headers a WebView Request drops', async () => {
    // A WebView (Chromium) quietly removes these from a Request; Node keeps them, so remove them here too.
    class WebViewRequest extends Request {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(input, init);
        for (const h of ['user-agent', 'referer', 'origin', 'cookie']) this.headers.delete(h);
      }
    }
    vi.stubGlobal('Request', WebViewRequest);
    const seen = fakeHost();
    await anyFetch('https://www.youtube.com/youtubei/v1/search', {
      method: 'POST',
      headers: { 'User-Agent': 'Desktop browser', Referer: 'https://www.youtube.com/', Cookie: 'made=up', 'Content-Type': 'application/json' },
      body: '{"query":"cats"}',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.req).toEqual({
      url: 'https://www.youtube.com/youtubei/v1/search',
      method: 'POST',
      headers: { 'user-agent': 'Desktop browser', referer: 'https://www.youtube.com/', 'content-type': 'application/json' },
      body: '{"query":"cats"}',
    });
  });

  it('sends no body for a GET', async () => {
    const seen = fakeHost();
    await anyFetch('https://i.ytimg.com/vi/abcdefghijk/mqdefault.jpg');
    expect(seen[0]!.req.method).toBe('GET');
    expect(seen[0]!.req.body).toBeUndefined();
  });

  it('answers with the status, headers, final address and the body read across chunks', async () => {
    // "é" is two bytes, split here between chunks.
    fakeHost((req) => ({
      status: 206,
      statusText: 'Partial Content',
      url: `${req.url}?final`,
      headers: { 'content-type': 'text/plain; charset=utf-8', 'content-range': 'bytes 0-5/9' },
      body: stream(bytes(0x68, 0xc3), bytes(0xa9, 0x6c, 0x6c, 0x6f)),
    }));
    const res = await anyFetch('https://v.example/a.txt');
    expect([res.status, res.statusText, res.ok, res.url]).toEqual([206, 'Partial Content', true, 'https://v.example/a.txt?final']);
    expect(res.headers.get('content-range')).toBe('bytes 0-5/9');
    expect(await res.text()).toBe('héllo');
  });

  it('gives no body for a HEAD request or a 204 and lets the host stop sending one', async () => {
    let cancelled = 0;
    const open = () =>
      new ReadableStream<Uint8Array>({
        cancel() {
          cancelled++;
        },
      });
    fakeHost((req) => ({ status: req.method === 'HEAD' ? 200 : 204, body: open() }));
    expect((await anyFetch('https://v.example/a', { method: 'HEAD' })).body).toBeNull();
    expect((await anyFetch('https://v.example/b')).body).toBeNull();
    await vi.waitFor(() => expect(cancelled).toBe(2));
  });

  it('keeps cookies out of the Response, and drops a status text it cannot carry', async () => {
    fakeHost(() => ({ statusText: 'Line\nBreak', headers: { 'Set-Cookie': 'a=1; Path=/', 'content-type': 'text/html' }, body: stream(bytes('<html>')) }));
    const res = await anyFetch('https://www.instagram.com/');
    expect(res.headers.has('set-cookie')).toBe(false);
    expect(res.headers.get('content-type')).toBe('text/html');
    expect(res.statusText).toBe('');
    expect(await res.text()).toBe('<html>');
  });

  it('passes the signal on, and does not ask the host at all once it has been aborted', async () => {
    const seen = fakeHost();
    const ctl = new AbortController();
    await anyFetch('https://v.example/a', { signal: ctl.signal });
    expect(seen[0]!.signal?.aborted).toBe(false);
    ctl.abort();
    expect(seen[0]!.signal?.aborted).toBe(true);
    await expect(anyFetch('https://v.example/b', { signal: ctl.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(seen).toHaveLength(1);
  });

  it('lets a failure to reach the site through, as fetch does', async () => {
    registerHostNetwork({
      request: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    await expect(anyFetch('https://v.example/a')).rejects.toThrow('Failed to fetch');
  });
});

describe('TikTok and Instagram requests through the host', () => {
  it('reads a text response with the final address and every header, cookies included', async () => {
    const seen = fakeHost(() => ({
      status: 200,
      url: 'https://www.instagram.com/p/abc/',
      headers: { 'Set-Cookie': 'csrftoken=tok; Path=/, mid=1; Path=/', 'content-type': 'text/html; charset=utf-8' },
      body: stream(bytes(0x3c, 0x68, 0xc3), bytes(0xa9, 0x3e)),
    }));
    const ctl = new AbortController();
    const page = await nativeNet.text('https://instagram.com/p/abc', {
      method: 'POST',
      headers: { 'User-Agent': 'Desktop browser', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'a=1',
      signal: ctl.signal,
    });
    expect(seen[0]!.req).toEqual({
      url: 'https://instagram.com/p/abc',
      method: 'POST',
      headers: { 'User-Agent': 'Desktop browser', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'a=1',
    });
    expect(seen[0]!.signal).toBe(ctl.signal);
    expect(page).toEqual({
      status: 200,
      url: 'https://www.instagram.com/p/abc/',
      headers: { 'set-cookie': 'csrftoken=tok; Path=/, mid=1; Path=/', 'content-type': 'text/html; charset=utf-8' },
      text: '<hé>',
    });
  });

  it('reads an empty text response as empty text', async () => {
    fakeHost(() => ({ status: 204, body: null }));
    expect((await nativeNet.text('https://v.example/a')).text).toBe('');
  });

  it('downloads bytes through the host, with the range it asked for', async () => {
    const seen = fakeHost(() => ({ status: 206, headers: { 'content-range': 'bytes 0-4/10', 'content-type': 'video/mp4' }, body: stream(bytes('12345')) }));
    const res = await nativeNet.bytes('https://v.example/clip.mp4', { headers: { Range: 'bytes=0-4' } });
    expect(seen[0]!.req.headers).toMatchObject({ range: 'bytes=0-4' });
    expect([res.status, res.headers.get('content-range'), res.headers.get('content-type')]).toEqual([206, 'bytes 0-4/10', 'video/mp4']);
    expect(new TextDecoder().decode(await res.arrayBuffer())).toBe('12345');
  });

  it('refuses in a browser, with no host and no app', async () => {
    await expect(nativeNet.text('https://www.tiktok.com/')).rejects.toThrow(TypeError);
  });
});

describe('what a host switches on', () => {
  it('turns on YouTube search and download only while a host is registered', () => {
    expect(canUseYouTubeApi()).toBe(false);
    registerHostNetwork({ request: async () => Promise.reject(new TypeError('unused')) });
    expect(canUseYouTubeApi()).toBe(true);
    registerHostNetwork(undefined);
    expect(canUseYouTubeApi()).toBe(false);
  });

  it('leaves a plain browser on its own fetch', async () => {
    const browserFetch = vi.fn(async () => new Response('ok'));
    vi.stubGlobal('fetch', browserFetch);
    expect(await (await anyFetch('https://v.example/a')).text()).toBe('ok');
    expect(browserFetch).toHaveBeenCalledTimes(1);
  });
});
