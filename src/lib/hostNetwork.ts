/**
 * Lets an app that hosts ReelForge, such as Stream Studio's editor window, do the networking a web page
 * can't: requests that skip browser CORS rules and carry headers like User-Agent and Referer, which
 * YouTube, TikTok and Instagram check. The Android app gets the same from Capacitor (see native.ts).
 *
 * A host calls registerHostNetwork() before the app starts. Without one nothing here changes.
 *
 * This file imports nothing, so a screen can ask whether a host is there without pulling in the rest of
 * the networking code.
 */

/** One request as plain data. Bodies are text, as in the Android app. */
export interface HostRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface HostResponse {
  status: number;
  statusText: string;
  /** where the request ended up, after redirects */
  url: string;
  /** names in lower case; a header sent more than once is joined with ", ", and cookies are included */
  headers: Record<string, string>;
  /** read as it arrives; null when the response has no body */
  body: ReadableStream<Uint8Array> | null;
}

export interface HostNetwork {
  /**
   * Rejects with a TypeError when the site can't be reached, as fetch does. The signal stops the
   * request, and the body too once it is being read.
   */
  request(req: HostRequest, signal?: AbortSignal): Promise<HostResponse>;
}

let host: HostNetwork | undefined;

/** Installs the host's networking. Passing undefined takes it away again. */
export function registerHostNetwork(net: HostNetwork | undefined): void {
  host = net;
}

export const hostNetwork = (): HostNetwork | undefined => host;

export const hasHostNetwork = (): boolean => host !== undefined;
