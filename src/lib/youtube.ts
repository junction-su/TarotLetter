export interface VideoMeta {
  title: string;
  channelName: string;
  thumbnailUrl: string | null;
}

export interface TimecodeOption {
  label: string; // clean label without timestamp, e.g. "Pile 2"
  time: string; // "MM:SS" or "HH:MM:SS"
  startSeconds: number;
}

/**
 * Extract video ID from various YouTube URL formats.
 * Handles: watch?v=ID, watch?v=ID&t=..., youtu.be/ID, youtu.be/ID?si=...,
 * shorts/ID, embed/ID, live/ID, v/ID, and URLs with extra params.
 */
export function extractVideoId(url: string): string | null {
  try {
    const u = new URL(url);

    // youtu.be/VIDEO_ID
    if (u.hostname === "youtu.be") {
      const id = u.pathname.slice(1).split("/")[0];
      return id || null;
    }

    if (
      u.hostname === "www.youtube.com" ||
      u.hostname === "youtube.com" ||
      u.hostname === "m.youtube.com"
    ) {
      // /watch?v=VIDEO_ID (with any extra params like &t=, &si=, &list=)
      const v = u.searchParams.get("v");
      if (v) return v;

      // /shorts/ID, /embed/ID, /live/ID, /v/ID
      const pathMatch = u.pathname.match(
        /^\/(shorts|embed|live|v)\/([\w-]{11})/
      );
      if (pathMatch) return pathMatch[2];
    }
  } catch {
    // not a valid URL
  }
  return null;
}

/**
 * Fetch video metadata using oEmbed (no API key required).
 */
export async function fetchVideoMeta(url: string): Promise<VideoMeta | null> {
  const videoId = extractVideoId(url);
  if (!videoId) return null;

  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const res = await fetch(oembedUrl);
    if (!res.ok) return null;
    const data = await res.json();
    return {
      title: data.title ?? "Unknown Title",
      channelName: data.author_name ?? "Unknown Channel",
      thumbnailUrl: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
    };
  } catch {
    return null;
  }
}

/**
 * Result from the /api/metadata route.
 */
export interface MetadataResult {
  title: string | null;
  channelName: string | null;
  description: string | null;
  reason: string | null;
}

// ── Client-side YouTube HTML helpers ──

/**
 * Fetch the YouTube watch page directly from the browser.
 * The user's cookies (including accepted consent) are sent automatically,
 * which can bypass the GDPR consent wall that blocks server-side fetches.
 * Returns null if CORS or network errors prevent access.
 */
async function fetchWatchHtmlClient(
  videoId: string
): Promise<string | null> {
  try {
    const res = await fetch(
      `https://www.youtube.com/watch?v=${videoId}&hl=en&persist_hl=1`,
      { credentials: "include" }
    );
    if (!res.ok) return null;
    return await res.text();
  } catch {
    // CORS or network error — expected in most setups
    return null;
  }
}

/**
 * Extract ytInitialPlayerResponse JSON from raw YouTube watch page HTML.
 */
function parsePlayerResponseFromHtml(
  html: string
): Record<string, unknown> | null {
  const m = html.match(
    /ytInitialPlayerResponse\s*=\s*(\{[\s\S]+?\});\s*<\/script/
  );
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/**
 * Parse YouTube caption XML (<text> elements) into plain-text lines.
 * Works for both srv3 and legacy caption XML formats.
 */
function parseCaptionXml(xml: string): string[] {
  const segments: string[] = [];
  const textRe = /<text[^>]*>([\s\S]*?)<\/text>/g;
  let m: RegExpExecArray | null;
  while ((m = textRe.exec(xml)) !== null) {
    const decoded = m[1]
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n/g, " ")
      .trim();
    if (decoded) segments.push(decoded);
  }
  return segments;
}

/**
 * Fetch video metadata from the watch page (title, channel, description).
 *
 * Strategy chain:
 *   1. Server-side /api/metadata route (avoids CORS, but may hit consent wall)
 *   2. Client-side fetch from browser (uses user's YouTube cookies)
 *   3. Fail with reason
 */
export async function fetchMetadata(url: string): Promise<MetadataResult> {
  const videoId = extractVideoId(url);
  if (!videoId) {
    return {
      title: null,
      channelName: null,
      description: null,
      reason: "PLAYER_RESPONSE_NOT_FOUND",
    };
  }

  // Strategy 1: Server-side route
  try {
    const res = await fetch(
      `/api/metadata?v=${encodeURIComponent(videoId)}`
    );
    if (res.ok) {
      const data: MetadataResult = await res.json();
      if (data.title && data.channelName && data.reason !== "CONSENT_PAGE") {
        console.debug("[metadata] server route OK");
        return data;
      }
      console.debug(
        "[metadata] server route →",
        data.reason ?? "missing fields"
      );
    }
  } catch {
    console.debug("[metadata] server route network error");
  }

  // Strategy 2: Client-side fetch (browser cookies bypass consent)
  try {
    console.debug("[metadata] trying client-side fetch…");
    const html = await fetchWatchHtmlClient(videoId);
    if (html) {
      const pr = parsePlayerResponseFromHtml(html);
      if (pr) {
        const vd = pr.videoDetails as
          | { title?: string; author?: string; shortDescription?: string }
          | undefined;
        const mf = pr.microformat as
          | {
              playerMicroformatRenderer?: { ownerChannelName?: string };
            }
          | undefined;

        const title = vd?.title ?? null;
        const channelName =
          mf?.playerMicroformatRenderer?.ownerChannelName ??
          vd?.author ??
          null;
        const description = vd?.shortDescription ?? null;

        if (title && channelName) {
          console.debug("[metadata] client-side fetch OK");
          return { title, channelName, description, reason: null };
        }
      }
    }
  } catch {
    console.debug("[metadata] client-side fetch failed (CORS)");
  }

  // All strategies failed
  return {
    title: null,
    channelName: null,
    description: null,
    reason: "CONSENT_PAGE",
  };
}

/**
 * Build a thumbnail URL for a YouTube video.
 */
export function getThumbnailUrl(url: string): string | null {
  const id = extractVideoId(url);
  if (!id) return null;
  return `https://img.youtube.com/vi/${id}/mqdefault.jpg`;
}

/**
 * Convert a time string like "12:34" or "1:02:30" to total seconds.
 */
export function timeToSeconds(time: string): number {
  const parts = time.split(":").map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return parts[0] * 60 + parts[1];
}

/**
 * Parse timecodes from a text string (e.g. video description or title).
 *
 * Supports formats like:
 *   "Pile 1 00:32"          → { label: "Pile 1", time: "00:32" }
 *   "00:00 - Intro"         → { label: "Intro", time: "00:00" }
 *   "1번 카드 06:06"         → { label: "1번 카드", time: "06:06" }
 *   "👉 1번 카드 06:06"      → { label: "1번 카드", time: "06:06" }
 *   "1:24:48 Final pile"    → { label: "Final pile", time: "1:24:48" }
 *   "2번 (05:10)"           → { label: "2번", time: "05:10" }
 *   "Green Stone 12:44"     → { label: "Green Stone", time: "12:44" }
 *
 * Returns an array of { label, time, startSeconds } sorted by time ascending.
 */
export function parseTimecodes(text: string): TimecodeOption[] {
  if (!text) return [];

  const results: TimecodeOption[] = [];
  const timeRe = /(\d{1,2}:\d{2}(?::\d{2})?)/;
  const timeReGlobal = /\d{1,2}:\d{2}(?::\d{2})?/g;

  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = trimmed.match(timeRe);
    if (!match) continue;

    const time = match[1];

    // Remove all timestamps from label, then clean up separators
    let label = trimmed
      .replace(timeReGlobal, "")
      .replace(/[-–—|()[\]{}]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    // Strip leading non-letter/non-number characters (emoji, bullets, arrows)
    label = label.replace(/^[^\p{L}\p{N}]+/u, "").trim();

    if (!label) continue;

    results.push({ label, time, startSeconds: timeToSeconds(time) });
  }

  results.sort((a, b) => a.startSeconds - b.startSeconds);
  return results;
}

/**
 * Result from the transcript fetch API.
 * On success: transcript is a string, reason is null.
 * On failure: transcript is null, reason indicates why.
 */
export interface TranscriptResult {
  transcript: string | null;
  reason:
    | "CONSENT_PAGE"
    | "AGE_RESTRICTED"
    | "PLAYER_RESPONSE_NOT_FOUND"
    | "NO_CAPTIONS"
    | "CAPTION_FETCH_FAILED"
    | "ASR_NOT_CONFIGURED"
    | null;
  description: string | null;
  /** Which extraction strategy produced the transcript, or null if all failed. */
  strategy: "caption_tracks" | "timedtext_api" | "asr" | null;
}

/**
 * Attempt to fetch transcript text.
 *
 * Strategy chain:
 *   1. Server-side /api/transcript route (multiple sub-strategies)
 *   2. Client-side fetch from browser (uses user's YouTube cookies)
 *   3. Fail — user must paste manually
 */
export async function fetchTranscript(url: string): Promise<TranscriptResult> {
  const videoId = extractVideoId(url);
  if (!videoId) {
    return {
      transcript: null,
      reason: "PLAYER_RESPONSE_NOT_FOUND",
      description: null,
      strategy: null,
    };
  }

  // Strategy 1: Server-side route
  try {
    const res = await fetch(
      `/api/transcript?v=${encodeURIComponent(videoId)}`
    );
    if (res.ok) {
      const data: TranscriptResult = await res.json();
      if (data.transcript) {
        console.debug(
          "[transcript] server route OK, strategy:",
          data.strategy
        );
        return data;
      }
      // Only try client fallback for CONSENT_PAGE — other reasons mean
      // the video genuinely has no captions
      if (data.reason !== "CONSENT_PAGE") {
        console.debug("[transcript] server route →", data.reason);
        return data;
      }
      console.debug(
        "[transcript] server → CONSENT_PAGE, trying client fallback"
      );
    }
  } catch {
    console.debug("[transcript] server route network error");
  }

  // Strategy 2: Client-side fetch (browser cookies bypass consent)
  try {
    console.debug("[transcript] trying client-side fetch…");
    const html = await fetchWatchHtmlClient(videoId);
    if (html) {
      const pr = parsePlayerResponseFromHtml(html);
      if (pr) {
        const description =
          (
            pr.videoDetails as
              | { shortDescription?: string }
              | undefined
          )?.shortDescription ?? null;

        const captions = pr.captions as
          | {
              playerCaptionsTracklistRenderer?: {
                captionTracks?: { baseUrl: string; kind?: string }[];
              };
            }
          | undefined;

        const tracks =
          captions?.playerCaptionsTracklistRenderer?.captionTracks;

        if (tracks && tracks.length > 0) {
          const manual = tracks.find((t) => t.kind !== "asr");
          const track = manual ?? tracks[0];
          try {
            const captionRes = await fetch(track.baseUrl);
            if (captionRes.ok) {
              const xml = await captionRes.text();
              const segments = parseCaptionXml(xml);
              if (segments.length > 0) {
                console.debug("[transcript] client-side caption fetch OK");
                return {
                  transcript: segments.join("\n"),
                  reason: null,
                  description,
                  strategy: "caption_tracks",
                };
              }
            }
          } catch {
            console.debug(
              "[transcript] client-side caption XML fetch failed (CORS)"
            );
          }
        }

        return {
          transcript: null,
          reason: "NO_CAPTIONS",
          description,
          strategy: null,
        };
      }
    }
  } catch {
    console.debug("[transcript] client-side fetch failed (CORS)");
  }

  // All strategies failed
  return {
    transcript: null,
    reason: "CONSENT_PAGE",
    description: null,
    strategy: null,
  };
}

/**
 * Detect if text contains Korean characters.
 */
export function containsKorean(text: string): boolean {
  return /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/.test(text);
}
