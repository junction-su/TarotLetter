import { NextRequest, NextResponse } from "next/server";

// ── Types ──

export type TranscriptFailReason =
  | "CONSENT_PAGE"
  | "AGE_RESTRICTED"
  | "PLAYER_RESPONSE_NOT_FOUND"
  | "NO_CAPTIONS"
  | "CAPTION_FETCH_FAILED"
  | "ASR_NOT_CONFIGURED";

/** Which extraction path produced the transcript. */
export type TranscriptStrategy =
  | "caption_tracks"
  | "timedtext_api"
  | "asr"
  | null;

interface TranscriptSuccess {
  transcript: string;
  reason: null;
  description: string | null;
  strategy: TranscriptStrategy;
}

interface TranscriptFailure {
  transcript: null;
  reason: TranscriptFailReason;
  description: string | null;
  strategy: null;
}

type TranscriptResult = TranscriptSuccess | TranscriptFailure;

// ── Shared browser-like request headers ──

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9,ko;q=0.8",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Sec-Ch-Ua":
    '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  Referer: "https://www.youtube.com/",
  // SOCS cookie = pre-accepted GDPR consent (value from a real accept-all)
  Cookie: "SOCS=CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjQwNTI4LjA3X3AxGgJlbiACGgYIgMCxsgY; CONSENT=PENDING+987",
};

/**
 * GET /api/transcript?v=VIDEO_ID
 *
 * Strategy chain:
 *   1. Fetch YouTube watch page (hl=ko → hl=en fallback) and extract
 *      captionTracks from ytInitialPlayerResponse.
 *   2. If captionTracks unavailable, try YouTube timedtext API directly.
 *   3. If still nothing, try external ASR stub.
 *   4. Return { transcript, reason, description, strategy }.
 */
export async function GET(req: NextRequest) {
  const videoId = req.nextUrl.searchParams.get("v");
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) {
    return NextResponse.json({ error: "Invalid video ID" }, { status: 400 });
  }

  let description: string | null = null;

  try {
    // ── 1. Fetch watch page (try hl=ko first, then hl=en) ──
    const pageResult = await fetchWatchPage(videoId);

    if (pageResult.blocked) {
      return fail(pageResult.blocked, description);
    }

    const playerResponse = pageResult.playerResponse;
    if (!playerResponse) {
      // Neither language variant yielded a player response — try
      // timedtext API directly (step 2) before giving up.
      const ttText = await tryTimedtextApi(videoId);
      if (ttText) return ok(ttText, description, "timedtext_api");

      const asrText = await tryAsr(videoId);
      if (asrText) return ok(asrText, description, "asr");

      return fail(
        process.env.ASR_ENDPOINT ? "PLAYER_RESPONSE_NOT_FOUND" : "ASR_NOT_CONFIGURED",
        description,
      );
    }

    // ── Extract description ──
    const videoDetails = playerResponse.videoDetails as
      | { shortDescription?: string }
      | undefined;
    description = videoDetails?.shortDescription ?? null;

    // ── Age-gate check ──
    const playability = playerResponse.playabilityStatus as
      | { status?: string; reason?: string }
      | undefined;
    if (
      playability?.status === "LOGIN_REQUIRED" ||
      (playability?.reason && /age/i.test(playability.reason))
    ) {
      return fail("AGE_RESTRICTED", description);
    }

    // ── 2. Try captionTracks from player response ──
    const captions = playerResponse.captions as
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

      const captionRes = await fetch(track.baseUrl, {
        headers: { "User-Agent": BROWSER_HEADERS["User-Agent"] },
      });
      if (captionRes.ok) {
        const xml = await captionRes.text();
        const segments = parseCaptionXml(xml);
        if (segments.length > 0) {
          return ok(segments.join("\n"), description, "caption_tracks");
        }
      }
    }

    // ── 3. Timedtext API fallback ──
    const ttText = await tryTimedtextApi(videoId);
    if (ttText) return ok(ttText, description, "timedtext_api");

    // ── 4. ASR fallback ──
    const asrText = await tryAsr(videoId);
    if (asrText) return ok(asrText, description, "asr");

    // All strategies exhausted
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

// ── Response helpers ──

function ok(
  transcript: string,
  description: string | null,
  strategy: TranscriptStrategy,
) {
  return NextResponse.json<TranscriptResult>({
    transcript,
    reason: null,
    description,
    strategy,
  });
}

function fail(reason: TranscriptFailReason, description: string | null) {
  return NextResponse.json<TranscriptResult>({
    transcript: null,
    reason,
    description,
    strategy: null,
  });
}

// ── Watch page fetch with hl fallback ──

interface WatchPageResult {
  playerResponse: Record<string, unknown> | null;
  blocked: TranscriptFailReason | null;
}

/**
 * Fetch the YouTube watch page. Tries hl=ko first (many tarot readings
 * are Korean), then hl=en as a fallback. Returns the parsed
 * playerResponse, or a blocking reason if the page can't be used.
 */
async function fetchWatchPage(videoId: string): Promise<WatchPageResult> {
  for (const hl of ["ko", "en"]) {
    const res = await fetch(
      `https://www.youtube.com/watch?v=${videoId}&hl=${hl}&persist_hl=1&bpctr=9999999999`,
      { headers: BROWSER_HEADERS },
    );

    if (!res.ok) continue;

    const html = await res.text();

    // Consent / cookie-wall detection
    const blocked = detectBlockedPage(html);
    if (blocked) {
      // If the first hl hit consent, the second likely will too — but
      // try once more with the other language before giving up.
      if (hl === "ko") continue;
      return { playerResponse: null, blocked };
    }

    // Extract ytInitialPlayerResponse
    const pr = extractPlayerResponse(html);
    if (pr) return { playerResponse: pr, blocked: null };
  }

  return { playerResponse: null, blocked: null };
}

function detectBlockedPage(html: string): TranscriptFailReason | null {
  // Consent page indicators (GDPR cookie walls)
  if (
    html.includes("consent.youtube.com") ||
    html.includes("accounts.google.com/ServiceLogin") ||
    html.includes('action="https://consent.google.com') ||
    html.includes("CONSENT_PENDING") ||
    (html.includes("<form") && html.includes("consent") && !html.includes("ytInitialPlayerResponse"))
  ) {
    return "CONSENT_PAGE";
  }

  // Age-restriction indicators in raw HTML
  if (
    html.includes("og:restrictions:age") ||
    html.includes('"reason":"Sign in to confirm your age"') ||
    html.includes("playerLegacyDesktopYpcOfferRenderer")
  ) {
    return "AGE_RESTRICTED";
  }

  return null;
}

function extractPlayerResponse(
  html: string,
): Record<string, unknown> | null {
  const m = html.match(
    /ytInitialPlayerResponse\s*=\s*(\{[\s\S]+?\});\s*<\/script/,
  );
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// ── Caption XML parsing ──

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

// ── Timedtext API fallback ──

/**
 * Attempt to fetch captions using YouTube's timedtext API directly.
 * This can succeed even when the watch page scraping fails, because it
 * doesn't require parsing HTML — it's a clean JSON/XML endpoint.
 *
 * Tries auto-generated captions for several common languages.
 */
async function tryTimedtextApi(videoId: string): Promise<string | null> {
  // Try auto-generated captions in order of likelihood for tarot content
  const langs = ["ko", "en", "ja", "es"];

  for (const lang of langs) {
    try {
      const url =
        `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}&fmt=srv3`;
      const res = await fetch(url, {
        headers: { "User-Agent": BROWSER_HEADERS["User-Agent"] },
      });
      if (!res.ok) continue;

      const xml = await res.text();
      // srv3 format is also XML with <text> elements
      const segments = parseCaptionXml(xml);
      if (segments.length > 0) return segments.join("\n");
    } catch {
      // Try next language
    }
  }

  // Also try the auto-detect endpoint (asr)
  try {
    const url =
      `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&kind=asr&fmt=srv3`;
    const res = await fetch(url, {
      headers: { "User-Agent": BROWSER_HEADERS["User-Agent"] },
    });
    if (res.ok) {
      const xml = await res.text();
      const segments = parseCaptionXml(xml);
      if (segments.length > 0) return segments.join("\n");
    }
  } catch {
    // Fall through
  }

  return null;
}

// ── ASR fallback stub ──

/**
 * Attempt speech-to-text via an external ASR service (e.g. Whisper).
 *
 * Requires the ASR_ENDPOINT env var to be set. POSTs { videoId } to
 * ASR_ENDPOINT/transcribe and expects { transcript: string } back.
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
