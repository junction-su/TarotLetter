// src/app/api/transcript/route.ts
import { NextRequest, NextResponse } from "next/server";

type ApiOk = {
  transcript: string | null;
  reason: string | null;
  description?: string | null;
  strategy?: string | null;
  error?: string | null;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function ytId(input: string | null): string | null {
  if (!input) return null;
  // allow raw id or full url
  const m1 = input.match(/^[a-zA-Z0-9_-]{11}$/);
  if (m1) return input;

  const m2 = input.match(/[?&]v=([a-zA-Z0-9_-]{11})/);
  if (m2) return m2[1];

  const m3 = input.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (m3) return m3[1];

  return null;
}

function normalizeTimedtextUrl(raw: string): string {
  // unescape JSON-escaped slashes and ampersands
  const unescaped = raw.replaceAll("\\/", "/").replaceAll("\\u0026", "&");

  // if relative path, make it absolute
  if (unescaped.startsWith("/api/")) return `https://www.youtube.com${unescaped}`;

  // some sources might return //www.youtube.com/...
  if (unescaped.startsWith("//")) return `https:${unescaped}`;

  return unescaped;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function looksLikeJson(ct: string | null): boolean {
  if (!ct) return false;
  return ct.includes("application/json") || ct.includes("text/json");
}

function isEmptyBodyText(t: string): boolean {
  return !t || t.trim().length === 0;
}

function jsonExtractDescription(html: string): string | null {
  // best-effort: YouTube watch page often contains JSON with shortDescription
  const m =
    html.match(/"shortDescription":"([^"]*)"/) ||
    html.match(/"description":{"simpleText":"([^"]*)"/);
  if (!m) return null;
  return m[1]
    .replaceAll("\\n", "\n")
    .replaceAll('\\"', '"')
    .replaceAll("\\u0026", "&");
}

// --- Strategy 1: Official timedtext XML/VTT (often empty for asr) ---
async function fetchTimedtextBasic(
  videoId: string,
  lang: string,
  asr: boolean
): Promise<{ transcript: string | null; reason: string | null; debug?: any }> {
  const params = new URLSearchParams();
  params.set("v", videoId);
  params.set("lang", lang);
  params.set("fmt", "vtt");
  if (asr) params.set("kind", "asr");

  const url = `https://www.youtube.com/api/timedtext?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "accept-language": "en-US,en;q=0.9,ko;q=0.8",
    },
    cache: "no-store",
  });

  const ct = res.headers.get("content-type");
  const text = await safeReadText(res);

  // YouTube sometimes returns 200 with text/html and empty body
  if (!res.ok || isEmptyBodyText(text)) {
    return {
      transcript: null,
      reason: "CAPTION_FETCH_FAILED",
      debug: { url, status: res.status, ct, bytes: text.length },
    };
  }

  // VTT parse: remove timestamps/WEBVTT metadata
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    if (s === "WEBVTT") continue;
    if (/^\d+$/.test(s)) continue;
    if (s.includes("-->")) continue;
    if (s.startsWith("Kind:")) continue;
    if (s.startsWith("Language:")) continue;
    out.push(s);
  }

  const transcript = out.join(" ").replace(/\s+/g, " ").trim();
  if (!transcript) {
    return {
      transcript: null,
      reason: "NO_CAPTIONS",
      debug: { url, status: res.status, ct, bytes: text.length },
    };
  }

  return { transcript, reason: null, debug: { url, status: res.status, ct, bytes: text.length } };
}

// --- Strategy 2: youtubei_player(pb3) JSON timedtext (your working path) ---
async function fetchTimedtextPb3Json(
  videoId: string,
  lang: string
): Promise<{
  transcript: string | null;
  reason: string | null;
  strategy?: string;
  debug?: any;
}> {
  // 1) load watch HTML
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}&hl=ko`;
  const watchRes = await fetch(watchUrl, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "accept-language": "en-US,en;q=0.9,ko;q=0.8",
    },
    cache: "no-store",
  });

  const watchHtml = await safeReadText(watchRes);

  // 2) find any timedtext URL candidates inside the HTML
  const candidates =
    watchHtml.match(/https:\\\/\\\/www\.youtube\.com\\\/api\\\/timedtext\?v=[^"\\]+/g) ||
    watchHtml.match(/https:\/\/www\.youtube\.com\/api\/timedtext\?v=[^"\\]+/g) ||
    watchHtml.match(/\/api\/timedtext\?v=[^"\\]+/g) ||
    [];

  if (candidates.length === 0) {
    return {
      transcript: null,
      reason: "NO_CAPTIONS",
      strategy: "youtubei_player",
      debug: { watchUrl, note: "no timedtext candidate found" },
    };
  }

  // pick first, normalize
  const base = normalizeTimedtextUrl(candidates[0]);

  // 3) build pb3 request
  // NOTE: Your success log showed these often present: caps=asr, hl=ko, ip=0.0.0.0, plus other tracking params.
  // We'll keep what we have, and enforce JSON output with fmt=json3 where possible.
  const u = new URL(base);
  u.searchParams.set("v", videoId);

  // ensure "asr" captions route is allowed
  // many pages use "caps=asr"
  if (!u.searchParams.has("caps")) u.searchParams.set("caps", "asr");

  // language
  u.searchParams.set("hl", "ko");
  // request json
  u.searchParams.set("fmt", "json3");
  // target caption language (for asr, this is the actual language)
  u.searchParams.set("lang", lang);

  // the ip=0.0.0.0 trick often makes YouTube return the pb3 JSON consistently
  // (You already observed this.)
  u.searchParams.set("ip", "0.0.0.0");

  const pb3Url = u.toString();

  const res = await fetch(pb3Url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "accept-language": "en-US,en;q=0.9,ko;q=0.8",
      accept: "application/json,text/plain,*/*",
    },
    cache: "no-store",
  });

  const ct = res.headers.get("content-type");

  // IMPORTANT: don’t call res.json() blindly
  const bodyText = await safeReadText(res);

  if (!res.ok || isEmptyBodyText(bodyText)) {
    return {
      transcript: null,
      reason: "CAPTION_FETCH_FAILED",
      strategy: "youtubei_player",
      debug: { pb3Url, status: res.status, ct, bytes: bodyText.length, head: bodyText.slice(0, 200) },
    };
  }

  // Sometimes YouTube lies with content-type; check first non-space char
  const first = bodyText.trimStart()[0];
  const maybeJson = looksLikeJson(ct) || first === "{" || first === "[";

  if (!maybeJson) {
    return {
      transcript: null,
      reason: "CAPTION_FETCH_FAILED",
      strategy: "youtubei_player",
      debug: { pb3Url, status: res.status, ct, bytes: bodyText.length, head: bodyText.slice(0, 200) },
    };
  }

  let json: any;
  try {
    json = JSON.parse(bodyText);
  } catch (e: any) {
    return {
      transcript: null,
      reason: "CAPTION_FETCH_FAILED",
      strategy: "youtubei_player",
      debug: {
        pb3Url,
        status: res.status,
        ct,
        bytes: bodyText.length,
        parseError: String(e?.message || e),
        head: bodyText.slice(0, 200),
      },
    };
  }

  // json3 format can be:
  // { events: [ {segs:[{utf8:"..."}]} ] }
  const events = Array.isArray(json?.events) ? json.events : [];
  const parts: string[] = [];
  for (const ev of events) {
    const segs = Array.isArray(ev?.segs) ? ev.segs : [];
    for (const s of segs) {
      const t = typeof s?.utf8 === "string" ? s.utf8 : "";
      if (t) parts.push(t);
    }
  }

  const transcript = parts.join("").replace(/\s+/g, " ").trim();
  if (!transcript) {
    return {
      transcript: null,
      reason: "NO_CAPTIONS",
      strategy: "youtubei_player",
      debug: { pb3Url, status: res.status, ct, bytes: bodyText.length },
    };
  }

  return {
    transcript,
    reason: null,
    strategy: "youtubei_player",
    debug: { pb3Url, status: res.status, ct, bytes: bodyText.length },
  };
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  const vRaw = searchParams.get("v");
  const tlang = searchParams.get("tlang"); // optional target language for future use
  const videoId = ytId(vRaw);

  if (!videoId) {
    const out: ApiOk = {
      transcript: null,
      reason: "BAD_REQUEST",
      error: "Missing or invalid video id",
      description: null,
      strategy: null,
    };
    return NextResponse.json(out, { status: 400 });
  }

  // 0) Grab description best-effort (for NO_CAPTIONS fallback UI)
  let description: string | null = null;
  try {
    const watchUrl = `https://www.youtube.com/watch?v=${videoId}&hl=ko`;
    const r = await fetch(watchUrl, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        "accept-language": "en-US,en;q=0.9,ko;q=0.8",
      },
      cache: "no-store",
    });
    const html = await safeReadText(r);
    description = jsonExtractDescription(html);
  } catch {
    // ignore
  }

  // 1) Prefer pb3 json (this is what worked for your auto-captions)
  const pb3 = await fetchTimedtextPb3Json(videoId, "ko");
  if (pb3.transcript) {
    const out: ApiOk = {
      transcript: pb3.transcript,
      reason: null,
      description,
      strategy: pb3.strategy ?? "youtubei_player",
    };
    return NextResponse.json(out);
  }

  // 2) fallback: try basic (manual captions sometimes work)
  const basic = await fetchTimedtextBasic(videoId, "ko", true);
  if (basic.transcript) {
    const out: ApiOk = {
      transcript: basic.transcript,
      reason: null,
      description,
      strategy: "timedtext_vtt",
    };
    return NextResponse.json(out);
  }

  // 3) final: no captions
  const out: ApiOk = {
    transcript: null,
    reason: pb3.reason || basic.reason || "NO_CAPTIONS",
    description,
    strategy: pb3.strategy ?? null,
    error:
      (pb3 as any)?.debug?.parseError ||
      (pb3 as any)?.debug?.note ||
      (basic as any)?.debug?.note ||
      null,
  };

  return NextResponse.json(out);
}
