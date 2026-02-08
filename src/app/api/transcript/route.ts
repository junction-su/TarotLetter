import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/transcript?v=VIDEO_ID
 *
 * Fetches YouTube captions by scraping the watch page for caption track URLs,
 * then fetching the XML caption track and extracting plain text.
 *
 * Returns { transcript: string | null }.
 * Returns null (not an error) when captions are unavailable — the caller
 * should fall back to manual entry.
 */
export async function GET(req: NextRequest) {
  const videoId = req.nextUrl.searchParams.get("v");
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) {
    return NextResponse.json({ error: "Invalid video ID" }, { status: 400 });
  }

  try {
    // 1. Fetch the YouTube watch page
    const watchRes = await fetch(
      `https://www.youtube.com/watch?v=${videoId}`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept-Language": "en-US,en;q=0.9",
        },
      }
    );

    if (!watchRes.ok) {
      return NextResponse.json({ transcript: null });
    }

    const html = await watchRes.text();

    // 2. Extract ytInitialPlayerResponse JSON
    const prMatch = html.match(
      /ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*<\/script/s
    );
    if (!prMatch) {
      return NextResponse.json({ transcript: null });
    }

    let playerResponse: Record<string, unknown>;
    try {
      playerResponse = JSON.parse(prMatch[1]);
    } catch {
      return NextResponse.json({ transcript: null });
    }

    // 3. Locate caption tracks
    const captions = playerResponse?.captions as
      | { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } }
      | undefined;

    const tracks = captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks || tracks.length === 0) {
      return NextResponse.json({ transcript: null });
    }

    // Prefer a manual track over auto-generated; fall back to the first one
    const manual = tracks.find((t) => t.kind !== "asr");
    const track = manual ?? tracks[0];

    // 4. Fetch the caption XML
    const captionRes = await fetch(track.baseUrl);
    if (!captionRes.ok) {
      return NextResponse.json({ transcript: null });
    }

    const xml = await captionRes.text();

    // 5. Parse <text> elements into plain-text lines
    const segments: string[] = [];
    const textRe = /<text[^>]*>([\s\S]*?)<\/text>/g;
    let m: RegExpExecArray | null;
    while ((m = textRe.exec(xml)) !== null) {
      const decoded = decodeXmlEntities(m[1]).replace(/\n/g, " ").trim();
      if (decoded) segments.push(decoded);
    }

    if (segments.length === 0) {
      return NextResponse.json({ transcript: null });
    }

    return NextResponse.json({ transcript: segments.join("\n") });
  } catch {
    return NextResponse.json({ transcript: null });
  }
}

// ── helpers ──

interface CaptionTrack {
  baseUrl: string;
  kind?: string;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
