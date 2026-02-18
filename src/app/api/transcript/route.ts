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

function looksLikeHtml(s: string): boolean {
  const t = s.trimStart();
  return (
    t.startsWith("<!doctype html") ||
    t.startsWith("<html") ||
    t.includes("<title>") ||
    t.includes("consent.youtube.com") ||
    t.includes("verify you are a human") ||
    t.includes("Sign in to YouTube")
  );
}

// watch HTML 안의 ytInitialPlayerResponse를 brace-matching으로 파싱
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
      if (ch === '"') {
        inString = false;
        continue;
      }
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

// JSON3에서 "utf8":"..."만 긁어서 텍스트로 복원
function extractUtf8Strings(body: string): string {
  const out: string[] = [];
  const re = /"utf8"\s*:\s*"((?:\\.|[^"\\])*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const raw = m[1]
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\\\/g, "\\");
    const cleaned = raw.replace(/\s+/g, " ").trim();
    if (cleaned) out.push(cleaned);
  }
  // 중복 줄이기
  const uniq: string[] = [];
  for (const s of out) {
    if (uniq.length === 0 || uniq[uniq.length - 1] !== s) uniq.push(s);
  }
  return uniq.join("\n").trim();
}

function withFmtJson3(url: string) {
  const u = new URL(url);
  // fmt 강제
  u.searchParams.set("fmt", "json3");
  return u.toString();
}

async function fetchText(url: string) {
  // IMPORTANT: HEAD 금지. 무조건 GET.
  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      // YouTube가 가끔 “봇”으로 보이면 HTML을 주기 때문에 브라우저스럽게
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9,ko;q=0.8",
      // timedtext는 보통 referer를 좋아함
      referer: "https://www.youtube.com/",
    },
    // Next/Node fetch 캐시 끄기
    cache: "no-store",
  });

  const text = await res.text();
  return {
    status: res.status,
    contentType: res.headers.get("content-type") || "",
    text,
  };
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const vid = extractVideoId(url.searchParams.get("v"));
  const tlang = url.searchParams.get("tlang") || "ko";
  const debugOn = url.searchParams.get("debug") === "1";

  const debug: any = { step: null };

  if (!vid) {
    const out: ApiOut = { transcript: null, reason: "MISSING_VIDEO_ID" };
    return NextResponse.json(out, { status: 400 });
  }

  // 1) watch 페이지에서 playerResponse 파싱
  debug.step = "fetch_watch";
  const watchUrl = `https://www.youtube.com/watch?v=${vid}`;
  const watch = await fetchText(watchUrl);

  debug.watch = debugOn
    ? { status: watch.status, contentType: watch.contentType, bytes: watch.text.length }
    : undefined;

  if (watch.status !== 200 || !watch.text) {
    const out: ApiOut = { transcript: null, reason: "WATCH_FETCH_FAILED", error: `status=${watch.status}` };
    if (debugOn) out.debug = debug;
    return NextResponse.json(out);
  }

  const player =
    findBalancedJsonAfter(watch.text, "var ytInitialPlayerResponse =") ||
    findBalancedJsonAfter(watch.text, "ytInitialPlayerResponse =");

  if (!player) {
    const out: ApiOut = { transcript: null, reason: "PLAYER_PARSE_FAILED" };
    if (debugOn) out.debug = debug;
    return NextResponse.json(out);
  }

  const description = extractDescription(player);
  const chosenTrack = pickCaptionTrack(player, tlang);

  debug.step = "pick_track";
  if (debugOn) {
    debug.chosenTrack = chosenTrack
      ? {
          languageCode: chosenTrack.languageCode,
          vssId: chosenTrack.vssId,
          name: chosenTrack.name,
          baseUrlHead: String(chosenTrack.baseUrl || "").slice(0, 180),
        }
      : null;
  }

  if (!chosenTrack?.baseUrl) {
    const out: ApiOut = {
      transcript: null,
      reason: "NO_CAPTIONS",
      description,
      strategy: null,
    };
    if (debugOn) out.debug = debug;
    return NextResponse.json(out);
  }

  // 2) baseUrl에 fmt=json3 강제해서 GET
  debug.step = "fetch_timedtext_json3";
  const ttUrl = withFmtJson3(chosenTrack.baseUrl);
  const timed = await fetchText(ttUrl);

  if (debugOn) {
    debug.timedtext = {
      url: ttUrl.slice(0, 240),
      status: timed.status,
      contentType: timed.contentType,
      bytes: timed.text.length,
      head: timed.text.slice(0, 120),
    };
  }

  // HTML이면 YouTube가 자막을 안 주고 있는 것
  if (timed.status !== 200 || !timed.text || looksLikeHtml(timed.text)) {
    const out: ApiOut = {
      transcript: null,
      reason: "CAPTION_FETCH_FAILED",
      description,
      strategy: "timedtext_json3",
      error:
        timed.status !== 200
          ? `status=${timed.status}`
          : looksLikeHtml(timed.text)
          ? "timedtext returned HTML (blocked/consent)"
          : "empty timedtext body",
    };
    if (debugOn) out.debug = debug;
    return NextResponse.json(out);
  }

  // 3) JSON3 내용에서 utf8 텍스트 추출
  debug.step = "extract_utf8";
  const transcript = extractUtf8Strings(timed.text);

  if (!transcript) {
    const out: ApiOut = {
      transcript: null,
      reason: "CAPTION_PARSE_FAILED",
      description,
      strategy: "timedtext_json3",
      error: "no utf8 strings found",
    };
    if (debugOn) out.debug = debug;
    return NextResponse.json(out);
  }

  const out: ApiOut = {
    transcript,
    reason: null,
    description,
    strategy: "timedtext_json3",
  };
  if (debugOn) out.debug = debug;
  return NextResponse.json(out);
}
