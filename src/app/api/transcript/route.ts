import { NextRequest, NextResponse } from "next/server";

/**
 * Failure reasons returned when transcript extraction fails.
 * The client uses these to show context-specific fallback messages.
 */
export type TranscriptFailReason =
  | "CONSENT_PAGE"
  | "AGE_RESTRICTED"
  | "PLAYER_RESPONSE_NOT_FOUND"
  | "NO_CAPTIONS"
  | "CAPTION_FETCH_FAILED";

interface TranscriptSuccess {
  transcript: string;
  reason: null;
}

interface TranscriptFailure {
  transcript: null;
  reason: TranscriptFailReason;
}

type TranscriptResult = TranscriptSuccess | TranscriptFailure;

function fail(reason: TranscriptFailReason) {
  return NextResponse.json<TranscriptResult>({ transcript: null, reason });
}

/**
 * GET /api/transcript?v=VIDEO_ID
 *
 * Fetches YouTube captions by scraping the watch page for caption track URLs,
 * then fetching the XML caption track and extracting plain text.
 *
 * Returns { transcript, reason } — on success reason is null, on failure
 * transcript is null and reason indicates why.
 */
export async function GET(req: NextRequest) {
  const videoId = req.nextUrl.searchParams.get("v");
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) {
    return NextResponse.json({ error: "Invalid video ID" }, { status: 400 });
  }

  try {
    // 1. Fetch the YouTube watch page
    const watchRes = await fetch(
      `https://www.youtube.com/watch?v=${videoId}&hl=en`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      }
    );

    if (!watchRes.ok) {
      return fail("PLAYER_RESPONSE_NOT_FOUND");
    }

    const html = await watchRes.text();

    // 2. Detect consent / cookie-wall pages
    if (
      html.includes("consent.youtube.com") ||
      html.includes("accounts.google.com/ServiceLogin") ||
      html.includes('action="https://consent.google.com')
    ) {
      return fail("CONSENT_PAGE");
    }

    // 3. Detect age-restricted content
    if (
      html.includes("og:restrictions:age") ||
      html.includes('"reason":"Sign in to confirm your age"') ||
      html.includes("playerLegacyDesktopYpcOfferRenderer")
    ) {
      return fail("AGE_RESTRICTED");
    }

    // 4. Extract ytInitialPlayerResponse JSON
    const prMatch = html.match(
      /ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*<\/script/s
    );
    if (!prMatch) {
      return fail("PLAYER_RESPONSE_NOT_FOUND");
    }

    let playerResponse: Record<string, unknown>;
    try {
      playerResponse = JSON.parse(prMatch[1]);
    } catch {
      return fail("PLAYER_RESPONSE_NOT_FOUND");
    }

    // 5. Check for age-gate inside player response
    const playability = playerResponse?.playabilityStatus as
      | { status?: string; reason?: string }
      | undefined;

    if (
      playability?.status === "LOGIN_REQUIRED" ||
      (playability?.reason && /age/i.test(playability.reason))
    ) {
      return fail("AGE_RESTRICTED");
    }

    // 6. Locate caption tracks
    const captions = playerResponse?.captions as
      | {
          playerCaptionsTracklistRenderer?: {
            captionTracks?: CaptionTrack[];
          };
        }
      | undefined;

    const tracks = captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!tracks || tracks.length === 0) {
      return fail("NO_CAPTIONS");
    }

    // Prefer a manual track over auto-generated; fall back to the first one
    const manual = tracks.find((t) => t.kind !== "asr");
    const track = manual ?? tracks[0];

    // 7. Fetch the caption XML
    const captionRes = await fetch(track.baseUrl);
    if (!captionRes.ok) {
      return fail("CAPTION_FETCH_FAILED");
    }

    const xml = await captionRes.text();

    // 8. Parse <text> elements into plain-text lines
    const segments: string[] = [];
    const textRe = /<text[^>]*>([\s\S]*?)<\/text>/g;
    let m: RegExpExecArray | null;
    while ((m = textRe.exec(xml)) !== null) {
      const decoded = decodeXmlEntities(m[1]).replace(/\n/g, " ").trim();
      if (decoded) segments.push(decoded);
    }

    if (segments.length === 0) {
      return fail("CAPTION_FETCH_FAILED");
    }

    return NextResponse.json<TranscriptResult>({
      transcript: segments.join("\n"),
      reason: null,
    });
  } catch {
    return fail("CAPTION_FETCH_FAILED");
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
