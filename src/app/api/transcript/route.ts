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

const CONSENT_COOKIE = "CONSENT=YES+1; SOCS=CAI;";

const WATCH_HEADERS: Record<string, string> = {
  "User-Agent": UA,
  "Accept-Language": "en-US,en;q=0.9,ko;q=0.8",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  Referer: "https://www.youtube.com/",
  Cookie: CONSENT_COOKIE,
};

const CAPTION_HEADERS: Record<string, string> = {
  "User-Agent": UA,
  Accept: "*/*",
  Referer: "https://www.youtube.com/",
  Cookie: CONSENT_COOKIE,
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

  // /api/transcript?v=...&tlang=ko 로 자동번역 자막도 시도 가능
  const tlang = req.nextUrl.searchParams.get("tlang") || undefined;

  let description: string | null = null;

  try {
    // 1) watch HTML에서 pr + ytcfg 수집
    const page = await fetchWatchPage(videoId);
    if (page.blocked) return fail(page.blocked, description);

    const pr1 = page.playerResponse;
    if (pr1) {
      description = extractDescription(pr1);
      if (isAgeGate(pr1)) return fail("AGE_RESTRICTED", description);

      const tracks1 = extractCaptionTracks(pr1);
      if (tracks1.length) {
        const text1 = await fetchCaptionFromTracks(tracks1, tlang);
        if (text1) return ok(text1, description, "caption_tracks");
      }
    }

    // 2) captions가 watch HTML에 없으면 youtubei/v1/player로 재호출
    if (!page.ytApiKey || !page.clientName || !page.clientVersion) {
      return fail(pr1 ? "NO_CAPTIONS" : "PLAYER_RESPONSE_NOT_FOUND", description);
    }

    const pr2 = await fetchYoutubeiPlayer({
      videoId,
      apiKey: page.ytApiKey,
      clientName: page.clientName,
      clientVersion: page.clientVersion,
      visitorData: page.visitorData,
      signatureTimestamp: page.signatureTimestamp,
      hl: page.hlUsed ?? "en",
      gl: "US",
    });

    if (!pr2) return fail("PLAYER_RESPONSE_NOT_FOUND", description);

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

/** watch 페이지에서 ytInitialPlayerResponse + ytcfg(INNERTUBE_*, VISITOR_DATA, STS) 추출 */
async function fetchWatchPage(videoId: string): Promise<{
  playerResponse: any | null;
  blocked: TranscriptFailReason | null;
  ytApiKey: string | null;
  clientName: string | null;
  clientVersion: string | null;
  visitorData: string | null;
  signatureTimestamp: number | null;
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
        visitorData: null,
        signatureTimestamp: null,
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
        visitorData: null,
        signatureTimestamp: null,
        hlUsed: hl,
      };
    }

    const pr = extractInitialPlayerResponse(html);

    const ytApiKey = extractYtcfgValue(html, "INNERTUBE_API_KEY");
    const clientNameRaw = extractYtcfgValue(html, "INNERTUBE_CONTEXT_CLIENT_NAME");
    const clientVersion = extractYtcfgValue(html, "INNERTUBE_CONTEXT_CLIENT_VERSION");
    const visitorData = extractYtcfgValue(html, "VISITOR_DATA");
    const stsStr = extractYtcfgValue(html, "STS");

    const clientName = normalizeClientName(clientNameRaw);

    const signatureTimestamp =
      stsStr && /^\d+$/.test(stsStr) ? Number(stsStr) : null;

    return {
      playerResponse: pr,
      blocked: null,
      ytApiKey,
      clientName,
      clientVersion,
      visitorData,
      signatureTimestamp,
      hlUsed: hl,
    };
  }

  return {
    playerResponse: null,
    blocked: null,
    ytApiKey: null,
    clientName: null,
    clientVersion: null,
    visitorData: null,
    signatureTimestamp: null,
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
  return ps?.status === "LOGIN_REQUIRED" || !!(ps?.reason && /age/i.test(ps.reason));
}

function extractCaptionTracks(pr: any): Array<{ baseUrl: string; kind?: string }> {
  const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  return Array.isArray(tracks) ? tracks : [];
}

async function fetchCaptionFromTracks(
  tracks: Array<{ baseUrl: string; kind?: string }>,
  tlang?: string,
): Promise<string | null> {
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

/** 핵심: youtubei/v1/player 호출을 “웹 클라이언트처럼” */
async function fetchYoutubeiPlayer(opts: {
  videoId: string;
  apiKey: string;
  clientName: string;
  clientVersion: string;
  visitorData: string | null;
  signatureTimestamp: number | null;
  hl: string;
  gl: string;
}): Promise<any | null> {
  const endpoint = `https://www.youtube.com/youtubei/v1/player?key=${encodeURIComponent(
    opts.apiKey,
  )}`;

  const body: any = {
    videoId: opts.videoId,
    context: {
      client: {
        clientName: opts.clientName,
        clientVersion: opts.clientVersion,
        hl: opts.hl,
        gl: opts.gl,
        visitorData: opts.visitorData ?? undefined,
      },
    },
    // 이 두 개가 없으면 일부 응답이 줄어드는 경우가 있음
    contentCheckOk: true,
    racyCheckOk: true,
  };

  if (opts.signatureTimestamp) {
    body.playbackContext = {
      contentPlaybackContext: {
        signatureTimestamp: opts.signatureTimestamp,
      },
    };
  }

  const headers: Record<string, string> = {
    "User-Agent": UA,
    "Accept-Language": "en-US,en;q=0.9,ko;q=0.8",
    "Content-Type": "application/json",
    Origin: "https://www.youtube.com",
    Referer: "https://www.youtube.com/",
    Cookie: CONSENT_COOKIE,
    // ✅ 중요: 유튜브가 “내가 어떤 클라이언트냐” 판단할 때 헤더도 봄
    "X-Youtube-Client-Name": clientNameToHeader(opts.clientName),
    "X-Youtube-Client-Version": opts.clientVersion,
  };

  if (opts.visitorData) {
    headers["X-Goog-Visitor-Id"] = opts.visitorData;
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    redirect: "follow",
    cache: "no-store",
  });

  if (!res.ok) return null;

  return await res.json();
}

function normalizeClientName(v: string | null): string | null {
  if (!v) return null;
  if (/^\d+$/.test(v)) return "WEB"; // 숫자로 오면 WEB로
  return v;
}

// X-Youtube-Client-Name 헤더는 보통 숫자값을 기대함 (WEB=1)
function clientNameToHeader(name: string) {
  // 가장 흔한 케이스만 처리
  if (name === "WEB") return "1";
  // 다른 값이면 그냥 WEB로 취급
  return "1";
}

/** ytcfg 안에서 key 값 추출 (단순하지만 실용적으로) */
function extractYtcfgValue(html: string, key: string): string | null {
  // "KEY":"VALUE"
  const m1 = html.match(new RegExp(`${key}"\\s*:\\s*"([^"]+)"`));
  if (m1?.[1]) return m1[1];

  // KEY: "VALUE"
  const m2 = html.match(new RegExp(`${key}\\s*:\\s*"([^"]+)"`));
  if (m2?.[1]) return m2[1];

  // KEY: 12345 (숫자)
  const m3 = html.match(new RegExp(`${key}"?\\s*:\\s*(\\d+)`));
  if (m3?.[1]) return m3[1];

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

// ===== optional ASR =====
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
