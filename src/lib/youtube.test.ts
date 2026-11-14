import { beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadYouTube } from './youtube';

const SIZE = 3000;

// A stand-in for YouTube: what each client says about the video, and how much of each stream it lets through.
const yt = vi.hoisted(() => ({
  answers: {} as Record<string, unknown>,
  /** streams YouTube cuts off after their first bytes */
  cutOff: new Set<string>(),
  requests: [] as string[],
}));

vi.mock('./native', () => ({
  isNative: () => true,
  anyFetch: async (input: string) => {
    const url = new URL(input);
    const [from, to] = url.searchParams.get('range')!.split('-').map(Number);
    yt.requests.push(`${url.pathname} ${from}-${to}`);
    if (yt.cutOff.has(url.pathname) && to >= 1024) return new Response(null, { status: 403 });
    return new Response(new Uint8Array(Math.min(to, SIZE - 1) - from + 1));
  },
}));

vi.mock('youtubei.js/web', () => ({
  Platform: { shim: {} },
  Innertube: {
    create: async () => ({
      session: { player: {} },
      getBasicInfo: async (_id: string, { client }: { client: string }) => {
        const answer = yt.answers[client] ?? { playability_status: { status: 'UNPLAYABLE', reason: 'Not on this client' } };
        if (answer instanceof Error) throw answer;
        return answer;
      },
    }),
  },
}));

const stream = (path: string, mime: string, height?: number) => ({
  mime_type: mime,
  has_video: mime.startsWith('video/'),
  has_audio: mime.startsWith('audio/'),
  height,
  bitrate: 1000,
  content_length: SIZE,
  quality_label: height ? `${height}p` : undefined,
  decipher: async () => `https://gv.example${path}?expire=1`,
});

const playable = (prefix: string) => ({
  playability_status: { status: 'OK' },
  streaming_data: {
    adaptive_formats: [stream(`/${prefix}/video`, 'video/mp4; codecs="avc1.4d401f"', 720), stream(`/${prefix}/audio`, 'audio/mp4; codecs="mp4a.40.2"')],
    formats: [],
  },
  basic_info: { title: `From ${prefix}`, author: 'Channel', duration: 60 },
});

const options = { kind: 'video' as const, maxHeight: 720 };

describe('downloading from YouTube', () => {
  beforeEach(() => {
    yt.answers = {};
    yt.cutOff.clear();
    yt.requests.length = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('gets a video made for kids from the YouTube Kids client', async () => {
    yt.answers.VISIONOS = { playability_status: { status: 'UNPLAYABLE', reason: 'This video is not available' } };
    yt.answers.YTKIDS = playable('kids');
    const got = await downloadYouTube('abcdefghijk', options);
    expect(got.title).toBe('From kids');
    expect([got.video?.size, got.audio?.size]).toEqual([SIZE, SIZE]);
  });

  it('skips streams YouTube cuts off after the start without downloading them', async () => {
    yt.answers.VISIONOS = playable('first');
    yt.answers.YTKIDS = playable('second');
    yt.cutOff.add('/first/audio');
    const got = await downloadYouTube('abcdefghijk', options);
    expect(got.title).toBe('From second');
    expect(yt.requests.filter((r) => r.startsWith('/first/'))).toEqual(['/first/video 0-1023', '/first/video 1976-2999', '/first/audio 0-1023', '/first/audio 1976-2999']);
  });

  it('says YouTube refused the download when a client offers the video but won’t send it', async () => {
    yt.answers.VISIONOS = playable('first');
    yt.answers.YTKIDS = { playability_status: { status: 'UNPLAYABLE', reason: 'The page needs to be reloaded.' } };
    yt.cutOff.add('/first/video');
    await expect(downloadYouTube('abcdefghijk', options)).rejects.toThrow('YouTube refused the download (403).');
  });

  it('says what YouTube said when a video can’t be played at all', async () => {
    yt.answers.VISIONOS = Object.assign(new Error('This video is unavailable'), {
      info: { status: 'ERROR', reason: 'This video has been removed by the uploader' },
    });
    await expect(downloadYouTube('abcdefghijk', options)).rejects.toThrow('This video has been removed by the uploader');
  });

  it('explains YouTube’s bot check without asking to sign in', async () => {
    for (const client of ['VISIONOS', 'YTKIDS', 'IOS', 'MWEB'])
      yt.answers[client] = { playability_status: { status: 'LOGIN_REQUIRED', reason: 'Sign in to confirm you’re not a bot' } };
    await expect(downloadYouTube('abcdefghijk', options)).rejects.toThrow('YouTube thinks this phone might be a bot');
  });
});
