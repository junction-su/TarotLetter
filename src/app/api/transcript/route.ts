// src/app/api/transcript/route.ts
export const runtime = "nodejs";

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
export type TranscriptStrategy = "caption_tracks" | "timedtext_api" | "asr" | null;

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
// NOTE: 쿠키는 환경에 따라 먹히기도/안 먹히기도 함. 그래도 최소한 "CONSENT_PAGE" 진단 로그는 찍히게 해둠.
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
  Cookie: "CONSENT=YES+1; SOCS=CAI;",
};

/**
 * GET /api/transcript?v=VIDEO_ID
 *
 * Strategy chain:
 *   1. Fetch YouTube watch page (hl=ko → hl=en) and extract captionTracks from ytInitialPlayerResponse.
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
    // ── 1) watch page scraping ──
    const pageResult = await fetchWatchPage(videoId);

    if (pageResult.blocked) {
      return fail(pageResult.blocked, description);
    }

    const playerResponse = pageResult.playerResponse;
    if (!playerResponse) {
      // No player response in either language → try timedtext API
      const ttText = await tryTimedtextApi(videoId);
      if (ttText) return ok(ttText, description, "timedtext_api");

      const asrText = await tryAsr(videoId);
      if (asrText) return ok(asrText, description, "asr");

      return fail(
        process.env.ASR_ENDPOINT ? "PLAYER_RESPONSE_NOT_FOUND" : "ASR_NOT_CONFIGURED",
        description,
      );
    }

    // Extract description
    const videoDetails = playerResponse.videoDetails as
      | { shortDescription?: string }
      | undefined;
    description = videoDetails?.shortDescription ?? null;

    // Age gate check
    const playability = playerResponse.playabilityStatus as
      | { status?: string; reason?: string }
      | undefined;
    if (
      playability?.status === "LOGIN_REQUIRED" ||
      (playability?.reason && /age/i.test(playability.reason))
    ) {
      return fail("AGE_RESTRICTED", description);
    }

    // ── 2) captionTracks ──
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
        cache: "no-store",
      });

      if (captionRes.ok) {
        const xml = await captionRes.text();
        const segments = parseCaptionXml(xml);
        if (segments.length > 0) {
          return ok(segments.join("\n"), description, "caption_tracks");
        }
      }
    }

    // ── 3) timedtext fallback ──
    const ttText = await tryTimedtextApi(videoId);
    if (ttText) return ok(ttText, description, "timedtext_api");

    // ── 4) ASR fallback ──
    const asrText = await tryAsr(videoId);
    if (asrText) return ok(asrText, description, "asr");

    // All exhausted
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

function ok(transcript: string, description: string | null, strategy: TranscriptStrategy) {
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

async function fetchWatchPage(videoId: string): Promise<WatchPageResult> {
  for (const hl of ["ko", "en"] as const) {
    const watchUrl =
      `https://www.youtube.com/watch?v=${videoId}` +
      `&hl=${hl}&persist_hl=1&bpctr=9999999999&has_verified=1`;

    const res = await fetch(watchUrl, {
      headers: BROWSER_HEADERS,
      cache: "no-store",
    });

    if (!res.ok) continue;

    const html = await res.text();

    const blocked = detectBlockedPage(html);
    if (blocked) {
      console.log("BLOCKED:", blocked);
      console.log("BLOCKED HTML HEAD:", html.slice(0, 300));
      if (hl === "ko") continue; // try en once
      return { playerResponse: null, blocked };
    }

    const pr = extractPlayerResponse(html);
    if (pr) return { playerResponse: pr, blocked: null };
  }

  return { playerResponse: null, blocked: null };
}

function detectBlockedPage(html: string): TranscriptFailReason | null {
  if (
    html.includes("consent.youtube.com") ||
    html.includes("accounts.google.com/ServiceLogin") ||
    html.includes('action="https://consent.google.com') ||
    html.includes("CONSENT_PENDING") ||
    (html.includes("<form") &&
      html.toLowerCase().includes("consent") &&
      !html.includes("ytInitialPlayerResponse"))
  ) {
    return "CONSENT_PAGE";
  }

  if (
    html.includes("og:restrictions:age") ||
    html.includes('"reason":"Sign in to confirm your age"') ||
    html.includes("playerLegacyDesktopYpcOfferRenderer")
  ) {
    return "AGE_RESTRICTED";
  }

  return null;
}

function extractPlayerResponse(html: string): Record<string, unknown> | null {
  // ES2017 호환: /s 대신 [\s\S]
  const m = html.match(/ytInitialPlayerResponse\s*=\s*(\{[\s\S]+?\});\s*<\/script/);
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

async function tryTimedtextApi(videoId: string): Promise<string | null> {
  const langs = ["ko", "en", "ja", "es"];

  for (const lang of langs) {
    try {
      const url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}&fmt=srv3`;
      const res = await fetch(url, {
        headers: { "User-Agent": BROWSER_HEADERS["User-Agent"] },
        cache: "no-store",
      });

      if (!res.ok) continue;

      const xml = await res.text();
      const segments = parseCaptionXml(xml);
      if (segments.length > 0) return segments.join("\n");
    } catch {
      // try next
    }
  }

  // Auto-generated (asr) try
  try {
    const url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&kind=asr&fmt=srv3`;
    const res = await fetch(url, {
      headers: { "User-Agent": BROWSER_HEADERS["User-Agent"] },
      cache: "no-store",
    });

    if (res.ok) {
      const xml = await res.text();
      const segments = parseCaptionXml(xml);
      if (segments.length > 0) return segments.join("\n");
    }
  } catch {
    // ignore
  }

  return null;
}

// ── ASR fallback stub ──

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
