import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type ApiOut = {
  transcript: string | null;
  reason: string | null;
  description?: string | null;
  strategy?: string | null;
  error?: string | null;
  debug?: any;
};

function extractVideoId(input: string | null): string | null {
  if (!input) return null;
  if (/^[a-zA-Z0-9_-]{11}$/.test(input)) return input;
  const m1 = input.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (m1) return m1[1];
  const m2 = input.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (m2) return m2[1];
  return null;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function findBalancedJsonAfter(html: string, marker: string): any | null {
  const idx = html.indexOf(marker);
  if (idx < 0) return null;
  const start = html.indexOf("{", idx);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = start; i < html.length; i++) {
    const ch = html[i];

    if (inString) {
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (depth === 0) {
      const jsonStr = html.slice(start, i + 1);
      try {
        return JSON.parse(jsonStr);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function extractDescription(player: any): string | null {
  const sd = player?.videoDetails?.shortDescription;
  return typeof sd === "string" && sd.trim() ? sd : null;
}

function pickCaptionTrack(player: any, langPref: string) {
  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks) || tracks.length === 0) return null;

  return (
    tracks.find((t: any) => t?.languageCode === langPref) ||
    tracks.find((t: any) => (t?.languageCode || "").startsWith(langPref)) ||
    tracks.find((t: any) => (t?.vssId || "").includes(`.${langPref}`)) ||
    tracks[0]
  );
}

function looksLikeHtml(s: string): boolean {
  const t = s.trimStart().toLowerCase();
  return t.startsWith("<!doctype html") || t.startsWith("<html") || t.includes("consent.youtube.com");
}

function vttToPlainText(vtt: string): string {
  const lines = vtt.split(/\r?\n/);
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "WEBVTT") continue;
    if (/^\d+$/.test(line)) continue;
    if (line.includes("-->")) continue;
    if (/^NOTE\b/i.test(line)) continue;

    const cleaned = line
      .replace(/<\/?c[^>]*>/g, "")
      .replace(/<\/?i>/g, "")
      .replace(/<\/?b>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .trim();

    if (cleaned) out.push(cleaned);
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

function xmlTimedtextToPlainText(xml: string): string {
  const out: string[] = [];
  const re = /<text[^>]*>([\s\S]*?)<\/text>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const s = m[1]
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (s) out.push(s);
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

function extractUtf8StringsFromJsonLikeText(body: string): string {
  const results: string[] = [];
  const re = /"utf8"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    try {
      const decoded = JSON.parse(`"${m[1]}"`).trim();
      if (decoded) results.push(decoded);
    } catch {}
  }
  return results.join(" ").replace(/\s+/g, " ").trim();
}

function normalizeTranscript(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// ✅ 핵심: watch 응답의 Set-Cookie → "Cookie:" 헤더로 합치기
function getCookieHeaderFromSetCookie(setCookies: string[]): string {
  // "NAME=VALUE; Path=/; ..." → "NAME=VALUE"
  const pairs = setCookies
    .map((sc) => sc.split(";")[0].trim())
    .filter(Boolean);

  // 중복 제거(뒤에 나온 값 우선)
  const map = new Map<string, string>();
  for (const p of pairs) {
    const eq = p.indexOf("=");
    if (eq > 0) {
      map.set(p.slice(0, eq), p);
    }
  }
  return Array.from(map.values()).join("; ");
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const v = extractVideoId(url.searchParams.get("v"));
  const tlang = (url.searchParams.get("tlang") || "ko").trim();
  const debugOn = url.searchParams.get("debug") === "1";
  const debug: any = { step: "start", tlang };

  if (!v) {
    const out: ApiOut = { transcript: null, reason: "INVALID_VIDEO_ID", error: "Missing/invalid v parameter" };
    return NextResponse.json(out, { status: 400 });
  }

  const watchUrl = `https://www.youtube.com/watch?v=${v}&hl=${encodeURIComponent(tlang)}&persist_gl=1&persist_hl=1`;
  debug.step = "fetch_watch";

  const ua =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
  const acceptLang = tlang === "en" ? "en-US,en;q=0.9" : "ko-KR,ko;q=0.9,en;q=0.6";

  const watchRes = await fetch(watchUrl, {
    method: "GET",
    cache: "no-store",
    headers: {
      "User-Agent": ua,
      "Accept-Language": acceptLang,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      // 리퍼러 의미는 없지만 watch 자체는 크게 상관 없음
    },
  });

  const watchHtml = await safeText(watchRes);
  debug.watch = { status: watchRes.status, bytes: watchHtml.length };

  // ✅ Node fetch(undici)에서 set-cookie 여러 개 받기
  const anyHeaders: any = watchRes.headers as any;
  const setCookies: string[] =
    typeof anyHeaders.getSetCookie === "function"
      ? anyHeaders.getSetCookie()
      : (watchRes.headers.get("set-cookie") ? [watchRes.headers.get("set-cookie") as string] : []);

  const cookieHeader = setCookies.length ? getCookieHeaderFromSetCookie(setCookies) : "";
  debug.cookies = { setCookieCount: setCookies.length, cookieHeaderBytes: cookieHeader.length };

  if (!watchRes.ok || !watchHtml) {
    const out: ApiOut = { transcript: null, reason: "WATCH_FETCH_FAILED", error: `watch status=${watchRes.status}` };
    if (debugOn) out.debug = debug;
    return NextResponse.json(out);
  }

  let player = findBalancedJsonAfter(watchHtml, "ytInitialPlayerResponse");
  if (!player) player = findBalancedJsonAfter(watchHtml, "var ytInitialPlayerResponse");

  if (!player) {
    const out: ApiOut = { transcript: null, reason: "PLAYER_PARSE_FAILED", error: "Could not parse ytInitialPlayerResponse" };
    if (debugOn) out.debug = { ...debug, htmlHead: watchHtml.slice(0, 500) };
    return NextResponse.json(out);
  }

  const description = extractDescription(player);
  debug.step = "pick_track";

  const chosenTrack = pickCaptionTrack(player, tlang);
  debug.chosenTrack = chosenTrack
    ? {
        name: chosenTrack?.name?.simpleText,
        languageCode: chosenTrack?.languageCode,
        vssId: chosenTrack?.vssId,
        kind: chosenTrack?.kind,
        baseUrlHead: typeof chosenTrack?.baseUrl === "string" ? chosenTrack.baseUrl.slice(0, 140) : null,
      }
    : null;

  if (!chosenTrack?.baseUrl) {
    const out: ApiOut = { transcript: null, reason: "NO_CAPTIONS", description, strategy: null };
    if (debugOn) out.debug = debug;
    return NextResponse.json(out);
  }

  debug.step = "fetch_timedtext_raw";

  const timedRes = await fetch(chosenTrack.baseUrl, {
    method: "GET",
    cache: "no-store",
    headers: {
      "User-Agent": ua,
      "Accept-Language": acceptLang,
      Accept: "*/*",
      // ✅ 이 2개가 꽤 중요
      Referer: watchUrl,
      Origin: "https://www.youtube.com",
      // ✅ watch에서 받은 쿠키 전달
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
    },
  });

  const timedBody = await safeText(timedRes);
  const ctype = timedRes.headers.get("content-type") || "";
  debug.timedtext = { status: timedRes.status, contentType: ctype, bytes: timedBody.length, head: timedBody.slice(0, 200) };

  if (!timedRes.ok || !timedBody) {
    const out: ApiOut = {
      transcript: null,
      reason: "CAPTION_FETCH_FAILED",
      description,
      strategy: "timedtext_raw",
      error: `timedtext status=${timedRes.status}, bytes=${timedBody.length}, ct=${ctype}`,
    };
    if (debugOn) out.debug = debug;
    return NextResponse.json(out);
  }

  debug.step = "parse_timedtext";

  let transcript = "";
  let strategy = "timedtext_raw";

  if (ctype.includes("application/json") || timedBody.trimStart().startsWith("{")) {
    transcript = extractUtf8StringsFromJsonLikeText(timedBody);
    strategy = "timedtext_json_utf8_regex";
  } else if (timedBody.includes("<transcript") || timedBody.includes("<text")) {
    transcript = xmlTimedtextToPlainText(timedBody);
    strategy = "timedtext_xml";
  } else if (timedBody.startsWith("WEBVTT") || timedBody.includes("-->")) {
    transcript = vttToPlainText(timedBody);
    strategy = "timedtext_vtt";
  } else if (looksLikeHtml(timedBody)) {
    transcript = "";
    strategy = "timedtext_html_blocked";
  } else {
    transcript = extractUtf8StringsFromJsonLikeText(timedBody);
    strategy = "timedtext_fallback_utf8";
  }

  transcript = normalizeTranscript(transcript);

  if (!transcript) {
    const out: ApiOut = {
      transcript: null,
      reason: "CAPTION_PARSE_FAILED",
      description,
      strategy,
      error: "Timedtext fetched but could not extract transcript text",
    };
    if (debugOn) out.debug = { ...debug, strategy };
    return NextResponse.json(out);
  }

  const out: ApiOut = { transcript, reason: null, description, strategy };
  if (debugOn) out.debug = { ...debug, strategy };
  return NextResponse.json(out);
}
