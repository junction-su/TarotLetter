import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";

type TranscriptFailReason =
  | "CONSENT_PAGE"
  | "AGE_RESTRICTED"
  | "PLAYER_RESPONSE_NOT_FOUND"
  | "NO_CAPTIONS"
  | "CAPTION_FETCH_FAILED"
  | "ASR_NOT_CONFIGURED";

type TranscriptStrategy = "caption_tracks" | "timedtext_api" | "asr" | null;

type TranscriptResult =
  | {
      transcript: string;
      reason: null;
      description: string | null;
      strategy: TranscriptStrategy;
    }
  | {
      transcript: null;
      reason: TranscriptFailReason;
      description: string | null;
      strategy: null;
    };

// ✅ metadata에서 성공했던 쿠키/헤더 느낌 그대로
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const WATCH_HEADERS: Record<string, string> = {
  "User-Agent": UA,
  "Accept-Language": "en-US,en;q=0.9,ko;q=0.8",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  Referer: "https://www.youtube.com/",
  Cookie: "CONSENT=YES+1; SOCS=CAI;",
};

const CAPTION_HEADERS: Record<string, string> = {
  "User-Agent": UA,
  Accept: "*/*",
  Referer: "https://www.youtube.com/",
  // 캡션도 같은 쿠키 주는 게 안전
  Cookie: "CONSENT=YES+1; SOCS=CAI;",
};

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

export async function GET(req: NextRequest) {
  const videoId = req.nextUrl.searchParams.get("v");
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) {
    return NextResponse.json({ error: "Invalid video ID" }, { status: 400 });
  }

  // 기본은 “원본 자막 언어 그대로”
  // 한국어로 강제하고 싶으면 /api/transcript?v=...&tlang=ko 로 호출
  const tlang = req.nextUrl.searchParams.get("tlang"); // "ko" 등
  let description: string | null = null;

  try {
    const page = await fetchWatchPage(videoId);
    if (page.blocked) return fail(page.blocked, description);

    const pr = page.playerResponse;
    if (!pr) {
      return fail("PLAYER_RESPONSE_NOT_FOUND", description);
    }

    // description
    const videoDetails = (pr.videoDetails ?? {}) as { shortDescription?: string };
    description = videoDetails.shortDescription ?? null;

    // age-gate
    const playability = (pr.playabilityStatus ?? {}) as { status?: string; reason?: string };
    if (
      playability.status === "LOGIN_REQUIRED" ||
      (playability.reason && /age/i.test(playability.reason))
    ) {
      return fail("AGE_RESTRICTED", description);
    }

    // captionTracks
    const captions = (pr.captions ?? {}) as {
      playerCaptionsTracklistRenderer?: {
        captionTracks?: Array<{ baseUrl: string; languageCode?: string; kind?: string }>;
      };
    };

    const tracks = captions.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    if (!tracks.length) return fail("NO_CAPTIONS", description);

    // 1) 가능한 한 “수동(=asr 아닌)” 우선
    // 2) 없으면 첫 번째 사용
    const manual = tracks.find((t) => t.kind !== "asr");
    const track = manual ?? tracks[0];

    // ✅ 브라우저처럼: baseUrl 그대로 + fmt 지정 + (원하면) tlang 붙이기
    const captionUrl = withQuery(track.baseUrl, {
      fmt: "srv3", // <text> XML이라 파싱 쉬움
      ...(tlang ? { tlang } : {}),
    });

    const captionRes = await fetch(captionUrl, {
      headers: CAPTION_HEADERS,
      redirect: "follow",
      cache: "no-store",
    });

    if (!captionRes.ok) {
      return fail("CAPTION_FETCH_FAILED", description);
    }

    const body = await captionRes.text();
    if (!body || body.length < 10) {
      // body가 진짜 비어있으면 “자막 없음” 가능성이 큼
      return fail("NO_CAPTIONS", description);
    }

    const segments = parseCaptionXml(body);
    if (!segments.length) {
      // fmt가 예상과 다르거나(드물게 vtt) 혹은 내용 구조 변경
      // 이때는 실패로 두되, 디버깅 가능하게 남김
      return fail("CAPTION_FETCH_FAILED", description);
    }

    return ok(segments.join("\n"), description, "caption_tracks");
  } catch {
    return fail("CAPTION_FETCH_FAILED", description);
  }
}

async function fetchWatchPage(videoId: string): Promise<{
  playerResponse: Record<string, any> | null;
  blocked: TranscriptFailReason | null;
}> {
  for (const hl of ["ko", "en"]) {
    const url =
      `https://www.youtube.com/watch?v=${videoId}` +
      `&hl=${hl}&gl=US&persist_hl=1&persist_gl=1&bpctr=9999999999&has_verified=1`;

    const res = await fetch(url, {
      headers: WATCH_HEADERS,
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
    if (pr) return { playerResponse: pr as any, blocked: null };
  }

  return { playerResponse: null, blocked: null };
}

function isConsentPage(html: string) {
  const hasConsent =
    html.includes("consent.youtube.com") ||
    html.includes('action="https://consent.google.com') ||
    html.includes("CONSENT_PENDING") ||
    html.includes("accounts.google.com/ServiceLogin");

  const hasPlayer = html.includes("ytInitialPlayerResponse");
  return hasConsent && !hasPlayer;
}

function isAgeRestricted(html: string) {
  return (
    html.includes("og:restrictions:age") ||
    html.includes('"reason":"Sign in to confirm your age"') ||
    html.includes("playerLegacyDesktopYpcOfferRenderer")
  );
}

// ✅ regex 대신 brace 매칭 (너가 metadata에서 성공한 방식)
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
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }

    if (ch === '"') {
      inStr = true;
      continue;
    }

    if (ch === "{") depth++;
    else if (ch === "}") depth--;

    if (depth === 0) return s.slice(start, i + 1);
  }
  return null;
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

function withQuery(baseUrl: string, params: Record<string, string>) {
  const u = new URL(baseUrl);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}
