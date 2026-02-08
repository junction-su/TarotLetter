import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

// ── Types ──
export type TranscriptFailReason =
  | "CONSENT_PAGE"
  | "AGE_RESTRICTED"
  | "PLAYER_RESPONSE_NOT_FOUND"
  | "NO_CAPTIONS"
  | "CAPTION_FETCH_FAILED"
  | "ASR_NOT_CONFIGURED";

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

// ── Shared headers (✅ metadata와 동일하게 유지) ──
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent": UA,
  "Accept-Language": "en-US,en;q=0.9,ko;q=0.8",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  Referer: "https://www.youtube.com/",
  // ✅ 핵심: consent 우회 쿠키 (metadata와 동일)
  Cookie: "CONSENT=YES+1; SOCS=CAI;",
};

// ── Route ──
export async function GET(req: NextRequest) {
  const videoId = req.nextUrl.searchParams.get("v");
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) {
    return NextResponse.json({ error: "Invalid video ID" }, { status: 400 });
  }

  let description: string | null = null;

  try {
    // 1) watch page에서 playerResponse 추출
    const page = await fetchWatchPage(videoId);
    if (page.blocked) return fail(page.blocked, description);

    const pr = page.playerResponse;
    if (!pr) {
      // watch 파싱 실패 시 timedtext 먼저 시도
      const tt = await tryTimedtextApi(videoId);
      if (tt) return ok(tt, description, "timedtext_api");

      const asr = await tryAsr(videoId);
      if (asr) return ok(asr, description, "asr");

      return fail(process.env.ASR_ENDPOINT ? "PLAYER_RESPONSE_NOT_FOUND" : "ASR_NOT_CONFIGURED", description);
    }

    // description
    const videoDetails = pr.videoDetails as { shortDescription?: string } | undefined;
    description = videoDetails?.shortDescription ?? null;

    // age gate
    const playability = pr.playabilityStatus as { status?: string; reason?: string } | undefined;
    if (
      playability?.status === "LOGIN_REQUIRED" ||
      (playability?.reason && /age/i.test(playability.reason))
    ) {
      return fail("AGE_RESTRICTED", description);
    }

    // 2) captionTracks 시도
    const captions = pr.captions as
      | { playerCaptionsTracklistRenderer?: { captionTracks?: CaptionTrack[] } }
      | undefined;

    const tracks = captions?.playerCaptionsTracklistRenderer?.captionTracks;

    if (tracks && tracks.length > 0) {
      const manual = tracks.find((t) => t.kind !== "asr");
      const track = manual ?? tracks[0];

      const captionRes = await fetch(track.baseUrl, {
        headers: { "User-Agent": UA },
        redirect: "follow",
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

    // 3) timedtext fallback
    const tt = await tryTimedtextApi(videoId);
    if (tt) return ok(tt, description, "timedtext_api");

    // 4) ASR fallback
    const asr = await tryAsr(videoId);
    if (asr) return ok(asr, description, "asr");

    // exhausted
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

// ── Helpers: response ──
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

// ── Helpers: watch page fetch + parse ──
interface WatchPageResult {
  playerResponse: Record<string, unknown> | null;
  blocked: TranscriptFailReason | null;
}

async function fetchWatchPage(videoId: string): Promise<WatchPageResult> {
  for (const hl of ["ko", "en"]) {
    const watchUrl =
      `https://www.youtube.com/watch?v=${videoId}` +
      `&hl=${hl}&gl=US&persist_hl=1&persist_gl=1&bpctr=9999999999&has_verified=1`;

    const res = await fetch(watchUrl, {
      headers: BROWSER_HEADERS,
      redirect: "follow",
      cache: "no-store",
    });

    if (!res.ok) continue;

    const html = await res.text();

    if (isConsentPage(html)) {
      if (hl === "ko") continue;
      return { playerResponse: null, blocked: "CONSENT_PAGE" };
    }

    if (isAgeRestricted(html)) {
      return { playerResponse: null, blocked: "AGE_RESTRICTED" };
    }

    const pr = extractInitialPlayerResponse(html);
    if (pr) return { playerResponse: pr, blocked: null };
  }

  return { playerResponse: null, blocked: null };
}

function isConsentPage(html: string) {
  const hasConsentDomain =
    html.includes("consent.youtube.com") ||
    html.includes('action="https://consent.google.com') ||
    html.includes("CONSENT_PENDING");

  const hasPlayer = html.includes("ytInitialPlayerResponse");
  return hasConsentDomain && !hasPlayer;
}

function isAgeRestricted(html: string) {
  return (
    html.includes("og:restrictions:age") ||
    html.includes('"reason":"Sign in to confirm your age"') ||
    html.includes("playerLegacyDesktopYpcOfferRenderer")
  );
}

// ✅ metadata에서 해결한 방식 그대로: brace 매칭
function extractInitialPlayerResponse(html: string): Record<string, unknown> | null {
  const key = "ytInitialPlayerResponse";
  const idx = html.indexOf(key);
  if (idx === -1) return null;

  const braceStart = html.indexOf("{", idx);
  if (braceStart === -1) return null;

  const jsonText = sliceBalancedBraces(html, braceStart);
  if (!jsonText) return null;

  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

function sliceBalancedBraces(s: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = start; i < s.length; i++) {
    const ch = s[i];

    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }

    if (ch === '"') {
      inStr = true;
      continue;
    }

    if (ch === "{") depth++;
    if (ch === "}") depth--;

    if (depth === 0) return s.slice(start, i + 1);
  }

  return null;
}

// ── Helpers: caption XML parsing ──
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

// ── Helpers: timedtext fallback ──
async function tryTimedtextApi(videoId: string): Promise<string | null> {
  const langs = ["ko", "en", "ja", "es"];

  for (const lang of langs) {
    const url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}&fmt=srv3`;
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      redirect: "follow",
      cache: "no-store",
    });

    if (!res.ok) continue;

    const xml = await res.text();
    const segments = parseCaptionXml(xml);
    if (segments.length > 0) return segments.join("\n");
  }

  // auto (asr)
  {
    const url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=en&kind=asr&fmt=srv3`;
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      redirect: "follow",
      cache: "no-store",
    });

    if (res.ok) {
      const xml = await res.text();
      const segments = parseCaptionXml(xml);
      if (segments.length > 0) return segments.join("\n");
    }
  }

  return null;
}

// ── Helpers: external ASR ──
async function tryAsr(videoId: string): Promise<string | null> {
  const endpoint = process.env.ASR_ENDPOINT;
  if (!endpoint) return null;

  const res = await fetch(`${endpoint}/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId }),
  });

  if (!res.ok) return null;

  const data: { transcript?: string } = await res.json();
  return data.transcript ?? null;
}
