export interface VideoMeta {
  title: string;
  channelName: string;
  thumbnailUrl: string | null;
}

export interface TimecodeOption {
  label: string;
  time: string; // "MM:SS" or "HH:MM:SS"
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
 * Build a thumbnail URL for a YouTube video.
 */
export function getThumbnailUrl(url: string): string | null {
  const id = extractVideoId(url);
  if (!id) return null;
  return `https://img.youtube.com/vi/${id}/mqdefault.jpg`;
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
 * Returns an array of { label, time } objects.
 */
export function parseTimecodes(text: string): TimecodeOption[] {
  if (!text) return [];

  const results: TimecodeOption[] = [];
  // Match timecodes in HH:MM:SS or MM:SS or M:SS format
  const timePattern = /(\d{1,2}:\d{2}(?::\d{2})?)/g;

  const lines = text.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = timePattern.exec(trimmed);
    if (match) {
      const time = match[1];
      // Build label from the non-timecode part of the line
      const label = trimmed
        .replace(timePattern, "")
        .replace(/[-–—|()[\]]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (label) {
        results.push({ label: `${label} (${time})`, time });
      }
    }
    // Reset regex lastIndex for next line
    timePattern.lastIndex = 0;
  }

  return results;
}

/**
 * Attempt to fetch transcript text via the server-side API route.
 * Returns the transcript string, or null if captions are unavailable.
 */
export async function fetchTranscript(url: string): Promise<string | null> {
  const videoId = extractVideoId(url);
  if (!videoId) return null;

  try {
    const res = await fetch(
      `/api/transcript?v=${encodeURIComponent(videoId)}`
    );
    if (!res.ok) return null;
    const data: { transcript: string | null } = await res.json();
    return data.transcript ?? null;
  } catch {
    return null;
  }
}

/**
 * Detect if text contains Korean characters.
 */
export function containsKorean(text: string): boolean {
  return /[\uAC00-\uD7AF\u1100-\u11FF\u3130-\u318F]/.test(text);
}
