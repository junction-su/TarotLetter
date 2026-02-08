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
  | "CAPTION_FETCH_FAILED"
  | "ASR_NOT_CONFIGURED";

interface TranscriptSuccess {
  transcript: string;
  reason: null;
  description: string | null;
}

interface TranscriptFailure {
  transcript: null;
  reason: TranscriptFailReason;
  description: string | null;
}

type TranscriptResult = TranscriptSuccess | TranscriptFailure;

/**
 * GET /api/transcript?v=VIDEO_ID
 *
 * 1. Fetches the YouTube watch page and extracts the player response.
 * 2. Returns the video description (for timestamp / card parsing).
 * 3. Tries YouTube captions first.
 * 4. If no captions, falls back to an ASR stub (Whisper-compatible).
 * 5. Returns { transcript, reason, description }.
 */
export async function GET(req: NextRequest) {
  const videoId = req.nextUrl.searchParams.get("v");
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) {
    return NextResponse.json({ error: "Invalid video ID" }, { status: 400 });
  }

  // description is extracted early and returned in every response so the
  // client can parse timestamp-based card options regardless of transcript
  // availability.
  let description: string | null = null;

  try {
    // ── 1. Fetch the YouTube watch page ──
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
      return fail("PLAYER_RESPONSE_NOT_FOUND", description);
    }

    const html = await watchRes.text();

    // ── 2. Detect consent / cookie-wall pages ──
    if (
      html.includes("consent.youtube.com") ||
      html.includes("accounts.google.com/ServiceLogin") ||
      html.includes('action="https://consent.google.com')
    ) {
      return fail("CONSENT_PAGE", description);
    }

    // ── 3. Detect age-restricted content ──
    if (
      html.includes("og:restrictions:age") ||
      html.includes('"reason":"Sign in to confirm your age"') ||
      html.includes("playerLegacyDesktopYpcOfferRenderer")
    ) {
      return fail("AGE_RESTRICTED", description);
    }

    // ── 4. Extract ytInitialPlayerResponse JSON ──
    const prMatch = html.match(
      /ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*<\/script/s
    );
    if (!prMatch) {
      return fail("PLAYER_RESPONSE_NOT_FOUND", description);
    }

    let playerResponse: Record<string, unknown>;
    try {
      playerResponse = JSON.parse(prMatch[1]);
    } catch {
      return fail("PLAYER_RESPONSE_NOT_FOUND", description);
    }

    // ── 5. Extract video description ──
    const videoDetails = playerResponse?.videoDetails as
      | { shortDescription?: string }
      | undefined;
    description = videoDetails?.shortDescription ?? null;

    // ── 6. Check for age-gate inside player response ──
    const playability = playerResponse?.playabilityStatus as
      | { status?: string; reason?: string }
      | undefined;

    if (
      playability?.status === "LOGIN_REQUIRED" ||
      (playability?.reason && /age/i.test(playability.reason))
    ) {
      return fail("AGE_RESTRICTED", description);
    }

    // ── 7. Try YouTube captions ──
    const captions = playerResponse?.captions as
      | {
          playerCaptionsTracklistRenderer?: {
            captionTracks?: CaptionTrack[];
          };
        }
      | undefined;

    const tracks = captions?.playerCaptionsTracklistRenderer?.captionTracks;

    if (tracks && tracks.length > 0) {
      const manual = tracks.find((t) => t.kind !== "asr");
      const track = manual ?? tracks[0];

      const captionRes = await fetch(track.baseUrl);
      if (captionRes.ok) {
        const xml = await captionRes.text();
        const segments = parseCaptionXml(xml);
        if (segments.length > 0) {
          return ok(segments.join("\n"), description);
        }
      }
      // caption fetch failed — fall through to ASR
    }

    // ── 8. ASR fallback ──
    const asrText = await tryAsr(videoId);
    if (asrText) {
      return ok(asrText, description);
    }

    // Both paths failed — pick the most accurate reason
    const reason: TranscriptFailReason =
      !tracks || tracks.length === 0
        ? process.env.ASR_ENDPOINT
          ? "NO_CAPTIONS"
          : "ASR_NOT_CONFIGURED"
        : "CAPTION_FETCH_FAILED";

    return fail(reason, description);
  } catch {
    return fail("CAPTION_FETCH_FAILED", description);
  }
}

// ── response helpers ──

function ok(transcript: string, description: string | null) {
  return NextResponse.json<TranscriptResult>({
    transcript,
    reason: null,
    description,
  });
}

function fail(reason: TranscriptFailReason, description: string | null) {
  return NextResponse.json<TranscriptResult>({
    transcript: null,
    reason,
    description,
  });
}

// ── caption XML parsing ──

interface CaptionTrack {
  baseUrl: string;
  kind?: string;
}

function parseCaptionXml(xml: string): string[] {
  const segments: string[] = [];
  const textRe = /<text[^>]*>([\s\S]*?)<\/text>/g;
  let m: RegExpExecArray | null;
  while ((m = textRe.exec(xml)) !== null) {
    const decoded = decodeXmlEntities(m[1]).replace(/\n/g, " ").trim();
    if (decoded) segments.push(decoded);
  }
  return segments;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

// ── ASR fallback stub ──

/**
 * Attempt speech-to-text via an external ASR service (e.g. Whisper).
 *
 * Requires the ASR_ENDPOINT env var to be set (e.g.
 * "http://localhost:9000"). When configured the stub POSTs
 * { videoId } to ASR_ENDPOINT/transcribe and expects
 * { transcript: string } back.
 *
 * Returns null when ASR is not configured or the call fails.
 */
async function tryAsr(videoId: string): Promise<string | null> {
  const endpoint = process.env.ASR_ENDPOINT;
  if (!endpoint) return null;

  try {
    const res = await fetch(`${endpoint}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ videoId }),
    });
    if (!res.ok) return null;
    const data: { transcript?: string } = await res.json();
    return data.transcript ?? null;
  } catch {
    return null;
  }
}
