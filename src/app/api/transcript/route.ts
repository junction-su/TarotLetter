import { NextRequest, NextResponse } from "next/server";
export const runtime = "nodejs";

type TranscriptFailReason =
  | "CONSENT_PAGE"
  | "AGE_RESTRICTED"
  | "PLAYER_RESPONSE_NOT_FOUND"
  | "NO_CAPTIONS"
  | "CAPTION_FETCH_FAILED"
  | "ASR_NOT_CONFIGURED";

type TranscriptStrategy = "caption_tracks" | "youtubei_player" | "asr" | null;

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

  // 원하면 /api/transcript?v=...&tlang=ko 로 “자동번역 자막”도 가능
  const tlang = req.nextUrl.searchParams.get("tlang") || undefined;

  let description: string | null = null;

  try {
    // 1) watch 페이지에서 playerResponse + ytcfg(키/버전) 뽑기
    const page = await fetchWatchPage(videoId);
    if (page.blocked) return fail(page.blocked, description);

    const pr1 = page.playerResponse;
    if (pr1) {
      description = extractDescription(pr1);
      if (isAgeGate(pr1)) return fail("AGE_RESTRICTED", description);

      const tracks1 = extractCaptionTracks(pr1);
      if (tracks1.length) {
        const text = await fetchCaptionFromTracks(tracks1, tlang);
        if (text) return ok(text, description, "caption_tracks");
      }
    }

    // 2) watch HTML에 captionTracks가 없으면: youtubei player API로 재시도
    if (!page.ytApiKey || !page.clientName || !page.clientVersion) {
      // youtubei 호출에 필요한 값이 없으면 여기서 끝
      return fail(pr1 ? "NO_CAPTIONS" : "PLAYER_RESPONSE_NOT_FOUND", description);
    }

    const pr2 = await fetchYoutubeiPlayer({
      videoId,
      apiKey: page.ytApiKey,
      clientName: page.clientName,
      clientVersion: page.clientVersion,
      hl: page.hlUsed ?? "en",
    });

    if (!pr2) return fail("PLAYER_RESPONSE_NOT_FOUND", description);

    // description은 여기서도 한 번 더 보정 가능
    description = description ?? extractDescription(pr2);

    if (isAgeGate(pr2)) return fail("AGE_RESTRICTED", description);

    const tracks2 = extractCaptionTracks(pr2);
    if (!tracks2.length) return fail("NO_CAPTIONS", description);

    const text2 = await fetchCaptionFromTracks(tracks2, tlang);
    if (text2) return ok(text2, description, "youtubei_player");

    return fail("CAPTION_FETCH_FAILED", description);
  } catch {
    return fail("CAPTION_FETCH_FAILED", description);
  }
}

/** watch 페이지 가져오기 + ytInitialPlayerResponse + ytcfg 키/버전 추출 */
async function fetchWatchPage(videoId: string): Promise<{
  playerResponse: any | null;
  blocked: TranscriptFailReason | null;
  ytApiKey: string | null;
  clientName: string | null;
  clientVersion: string | null;
  hlUsed: string | null;
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
      return {
        playerResponse: null,
        blocked: "CONSENT_PAGE",
        ytApiKey: null,
        clientName: null,
        clientVersion: null,
        hlUsed: hl,
      };
    }
    if (isAgeRestrictedHtml(html)) {
      return {
        playerResponse: null,
        blocked: "AGE_RESTRICTED",
        ytApiKey: null,
        clientName: null,
        clientVersion: null,
        hlUsed: hl,
      };
    }

    const pr = extractInitialPlayerResponse(html);

    const ytApiKey = extractYtcfgValue(html, "INNERTUBE_API_KEY");
    const clientName =
      extractYtcfgValue(html, "INNERTUBE_CONTEXT_CLIENT_NAME") ||
      "WEB"; // 안전 기본값
    const clientVersion =
      extractYtcfgValue(html, "INNERTUBE_CONTEXT_CLIENT_VERSION");

    return {
      playerResponse: pr,
      blocked: null,
      ytApiKey,
      clientName,
      clientVersion,
      hlUsed: hl,
    };
  }

  return {
    playerResponse: null,
    blocked: null,
    ytApiKey: null,
    clientName: null,
    clientVersion: null,
    hlUsed: null,
  };
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

function isAgeRestrictedHtml(html: string) {
  return (
    html.includes("og:restrictions:age") ||
    html.includes('"reason":"Sign in to confirm your age"') ||
    html.includes("playerLegacyDesktopYpcOfferRenderer")
  );
}

function extractDescription(pr: any): string | null {
  const vd = pr?.videoDetails as { shortDescription?: string } | undefined;
  return vd?.shortDescription ?? null;
}

function isAgeGate(pr: any) {
  const ps = pr?.playabilityStatus as { status?: string; reason?: string } | undefined;
  return (
    ps?.status === "LOGIN_REQUIRED" ||
    (ps?.reason && /age/i.test(ps.reason))
  );
}

function extractCaptionTracks(pr: any): Array<{ baseUrl: string; kind?: string; languageCode?: string }> {
  const tracks =
    pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  return Array.isArray(tracks) ? tracks : [];
}

/** captionTracks에서 자막 다운로드 (baseUrl은 서명 파라미터 포함 → 0바이트 문제 해결) */
async function fetchCaptionFromTracks(
  tracks: Array<{ baseUrl: string; kind?: string; languageCode?: string }>,
  tlang?: string,
): Promise<string | null> {
  // 수동 > 자동(asr) 우선
  const manual = tracks.find((t) => t.kind !== "asr");
  const track = manual ?? tracks[0];
  if (!track?.baseUrl) return null;

  const captionUrl = withQuery(track.baseUrl, {
    fmt: "srv3",
    ...(tlang ? { tlang } : {}),
  });

  const res = await fetch(captionUrl, {
    headers: CAPTION_HEADERS,
    redirect: "follow",
    cache: "no-store",
  });

  if (!res.ok) return null;

  const xmlText = await res.text();
  if (!xmlText || xmlText.length < 10) return null;

  const segments = parseCaptionXml(xmlText);
  if (!segments.length) return null;

  return segments.join("\n");
}

/** youtubei player API 호출 */
async function fetchYoutubeiPlayer(opts: {
  videoId: string;
  apiKey: string;
  clientName: string;
  clientVersion: string;
  hl: string;
}): Promise<any | null> {
  const endpoint = `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(
    opts.apiKey,
  )}`;

  const body = {
    videoId: opts.videoId,
    context: {
      client: {
        clientName: normalizeClientName(opts.clientName),
        clientVersion: opts.clientVersion,
        hl: opts.hl,
        gl: "US",
      },
    },
  };

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "User-Agent": UA,
      "Accept-Language": "en-US,en;q=0.9,ko;q=0.8",
      "Content-Type": "application/json",
      Origin: "https://www.youtube.com",
      Referer: "https://www.youtube.com/",
      Cookie: "CONSENT=YES+1; SOCS=CAI;",
    },
    body: JSON.stringify(body),
    redirect: "follow",
    cache: "no-store",
  });

  if (!res.ok) return null;
  return await res.json();
}

// ytcfg에선 숫자로 들어오는 경우도 있어서 WEB으로 normalize
function normalizeClientName(v: string) {
  // "1" 같은 숫자면 WEB으로
  if (/^\d+$/.test(v)) return "WEB";
  return v;
}

/** ytcfg.set({...}) 안에서 key 값 추출 (대충이라도 안정적으로) */
function extractYtcfgValue(html: string, key: string): string | null {
  // 1) "KEY":"VALUE"
  const m1 = html.match(new RegExp(`${key}"\\s*:\\s*"([^"]+)"`));
  if (m1?.[1]) return m1[1];

  // 2) KEY: "VALUE"
  const m2 = html.match(new RegExp(`${key}\\s*:\\s*"([^"]+)"`));
  if (m2?.[1]) return m2[1];

  return null;
}

// ===== ytInitialPlayerResponse 파싱 (brace 매칭) =====
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

// ===== caption xml parsing =====
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

// ===== ASR fallback (optional) =====
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
