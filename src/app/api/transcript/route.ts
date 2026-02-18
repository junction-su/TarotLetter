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
  const t = s.trimStart().toLowerCase();
  return (
    t.startsWith("<!doctype html") ||
    t.startsWith("<html") ||
    t.includes("<title>") ||
    t.includes("consent.youtube.com") ||
    t.includes("verify you are a human") ||
    t.includes("sign in to youtube")
  );
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

  const uniq: string[] = [];
  for (const s of out) {
    if (uniq.length === 0 || uniq[uniq.length - 1] !== s) uniq.push(s);
  }
  return uniq.join("\n").trim();
}

function withFmtJson3(url: string) {
  const u = new URL(url);
  u.searchParams.set("fmt", "json3");
  return u.toString();
}

// watch 페이지용 (HTML)
async function fetchHTML(url: string) {
  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    cache: "no-store",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": "en-US,en;q=0.9,ko;q=0.8",
    },
  });

  const ab = await res.arrayBuffer();
  const text = Buffer.from(ab).toString("utf8");

  return {
    status: res.status,
    contentType: res.headers.get("content-type") || "",
    contentLength: res.headers.get("content-length"),
    finalUrl: res.url,
    redirected: res.redirected,
    bytes: ab.byteLength,
    text,
  };
}

// timedtext용 (JSON/VTT 등) — HTML accept 절대 금지
async function fetchANY(url: string, referer?: string) {
  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    cache: "no-store",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      accept: "*/*",
      "accept-language": "en-US,en;q=0.9,ko;q=0.8",
      ...(referer ? { referer } : {}),
    },
  });

  const ab = await res.arrayBuffer();
  // NOTE: timedtext json3는 utf-8 텍스트라 그냥 utf8로 디코드
  const text = Buffer.from(ab).toString("utf8");

  return {
    status: res.status,
    contentType: res.headers.get("content-type") || "",
    contentLength: res.headers.get("content-length"),
    finalUrl: res.url,
    redirected: res.redirected,
    bytes: ab.byteLength,
    text,
  };
}

export async function GET(req: NextRequest) {
  const u = new URL(req.url);
  const vid = extractVideoId(u.searchParams.get("v"));
  const tlang = u.searchParams.get("tlang") || "ko";
  const debugOn = u.searchParams.get("debug") === "1";

  const debug: any = { step: null };

  if (!vid) {
    return NextResponse.json(
      { transcript: null, reason: "MISSING_VIDEO_ID" } satisfies ApiOut,
      { status: 400 }
    );
  }

  // 1) watch 페이지에서 playerResponse 파싱
  debug.step = "fetch_watch";
  const watchUrl = `https://www.youtube.com/watch?v=${vid}`;
  const watch = await fetchHTML(watchUrl);

  if (debugOn) {
    debug.watch = {
      status: watch.status,
      contentType: watch.contentType,
      contentLength: watch.contentLength,
      redirected: watch.redirected,
      finalUrl: watch.finalUrl,
      bytes: watch.bytes,
    };
  }

  if (watch.status !== 200 || !watch.text) {
    const out: ApiOut = {
      transcript: null,
      reason: "WATCH_FETCH_FAILED",
      error: `status=${watch.status}`,
    };
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
          baseUrlLen: String(chosenTrack.baseUrl || "").length,
          baseUrlHead: String(chosenTrack.baseUrl || "").slice(0, 180),
          baseUrlTail: String(chosenTrack.baseUrl || "").slice(-180),
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

  // 2) timedtext json3 강제 + GET only
  debug.step = "fetch_timedtext_json3";
  const ttUrl = withFmtJson3(chosenTrack.baseUrl);

  // referer를 watch로 걸어줌 (유튜브가 이거 좋아함)
  const timed = await fetchANY(ttUrl, watchUrl);

  if (debugOn) {
    debug.timedtext = {
      status: timed.status,
      contentType: timed.contentType,
      contentLength: timed.contentLength,
      redirected: timed.redirected,
      finalUrl: timed.finalUrl,
      bytes: timed.bytes,
      // URL은 너무 길어서 head/tail만
      urlHead: ttUrl.slice(0, 220),
      urlTail: ttUrl.slice(-220),
      head: timed.text.slice(0, 120),
    };
  }

  // 여기서 “진짜로 왜 실패인지”를 명확히 나눔
  if (timed.status !== 200) {
    const out: ApiOut = {
      transcript: null,
      reason: "CAPTION_FETCH_FAILED",
      description,
      strategy: "timedtext_json3",
      error: `status=${timed.status}`,
    };
    if (debugOn) out.debug = debug;
    return NextResponse.json(out);
  }

  if (timed.bytes === 0) {
    const out: ApiOut = {
      transcript: null,
      reason: "CAPTION_FETCH_FAILED",
      description,
      strategy: "timedtext_json3",
      error: "timedtext body is 0 bytes (blocked/expired/consent)",
    };
    if (debugOn) out.debug = debug;
    return NextResponse.json(out);
  }

  if (looksLikeHtml(timed.text)) {
    const out: ApiOut = {
      transcript: null,
      reason: "CAPTION_FETCH_FAILED",
      description,
      strategy: "timedtext_json3",
      error: "timedtext returned HTML (consent/bot-check/sign-in)",
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
