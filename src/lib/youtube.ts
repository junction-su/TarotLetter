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
 */
export function extractVideoId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname === "youtu.be") {
      return u.pathname.slice(1) || null;
    }
    if (
      u.hostname === "www.youtube.com" ||
      u.hostname === "youtube.com" ||
      u.hostname === "m.youtube.com"
    ) {
      return u.searchParams.get("v");
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

/**
 * Fetch video metadata from the watch page (title, channel, description).
 * Uses the server-side /api/metadata route to avoid CORS.
 */
export async function fetchMetadata(url: string): Promise<MetadataResult> {
  const videoId = extractVideoId(url);
  if (!videoId) {
    return { title: null, channelName: null, description: null, reason: "PLAYER_RESPONSE_NOT_FOUND" };
  }

  try {
    const res = await fetch(`/api/metadata?v=${encodeURIComponent(videoId)}`);
    if (!res.ok) {
      return { title: null, channelName: null, description: null, reason: "PLAYER_RESPONSE_NOT_FOUND" };
    }
    return await res.json();
  } catch {
    return { title: null, channelName: null, description: null, reason: "PLAYER_RESPONSE_NOT_FOUND" };
  }
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
 * Matches patterns like:
 *   "Pile 1 00:32"
 *   "2번 (05:10)"
 *   "00:00 - Intro"
 *   "Green Stone 12:44"
 *   "1:02:30 Final pile"
 *
 * Returns an array of { label, time, startSeconds } sorted by time.
 */
export function parseTimecodes(text: string): TimecodeOption[] {
  if (!text) return [];

  const results: TimecodeOption[] = [];
  const timePattern = /(\d{1,2}:\d{2}(?::\d{2})?)/g;

  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = timePattern.exec(trimmed);
    if (match) {
      const time = match[1];
      const label = trimmed
        .replace(timePattern, "")
        .replace(/[-–—|()[\]]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (label) {
        results.push({ label, time, startSeconds: timeToSeconds(time) });
      }
    }
    timePattern.lastIndex = 0;
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
}

/**
 * Attempt to fetch transcript text via the server-side API route.
 * Also returns the video description (for timestamp parsing).
 */
export async function fetchTranscript(url: string): Promise<TranscriptResult> {
  const videoId = extractVideoId(url);
  if (!videoId) {
    return { transcript: null, reason: "PLAYER_RESPONSE_NOT_FOUND", description: null };
  }

  try {
    const res = await fetch(
      `/api/transcript?v=${encodeURIComponent(videoId)}`
    );
    if (!res.ok) {
      return { transcript: null, reason: "CAPTION_FETCH_FAILED", description: null };
    }
    const data: TranscriptResult = await res.json();
    return {
      transcript: data.transcript ?? null,
      reason: data.reason ?? null,
      description: data.description ?? null,
    };
  } catch {
    return { transcript: null, reason: "CAPTION_FETCH_FAILED", description: null };
  }
}

/**
 * Detect if text contains Korean characters.
 */
export function containsKorean(text: string): boolean {
  return /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/.test(text);
}
