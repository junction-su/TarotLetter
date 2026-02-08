export interface VideoMeta {
  title: string;
  channelName: string;
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
