// src/app/api/transcript/route.ts
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

  // find first "{"
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

function extractDescriptionFromPlayerResponse(player: any): string | null {
  // best-effort
  const sd = player?.videoDetails?.shortDescription;
  if (typeof sd === "string" && sd.trim()) return sd;
  return null;
}

function extractCaptionBaseUrl(player: any, langPref: string): { url: string | null; chosen?: any } {
  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks) || tracks.length === 0) return { url: null };

  // Prefer matching language, else first track
  const byLang =
    tracks.find((t: any) => t?.languageCode === langPref) ||
    tracks.find((t: any) => (t?.languageCode || "").startsWith(langPref)) ||
    tracks[0];

  const baseUrl = typeof byLang?.baseUrl === "string" ? byLang.baseUrl : null;
  return { url: baseUrl, chosen: byLang };
}

async function fetchTranscriptFromBaseUrl(baseUrl: string): Promise<{ transcript: string | null; debug: any }> {
  // Force JSON3 output
  const u = new URL(baseUrl);
  u.searchParams.set("fmt", "json3");

  const url = u.toString();
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      accept: "application/json,text/plain,*/*",
      "accept-language": "en-US,en;q=0.9,ko;q=0.8",
    },
    cache: "no-store",
  });

  const ct = res.headers.get("content-type");
  const body = await safeText(res);

  // If empty or not JSON, stop here with debug
  const head = body.slice(0, 200);
  if (!res.ok || !body.trim()) {
    return {
      transcript: null,
      debug: { step: "timedtext_fetch", url, status: res.status, ct, bytes: body.length, head },
    };
  }

  const first = body.trimStart()[0];
  if (!(first === "{" || first === "[")) {
    return {
      transcript: null,
      debug: { step: "timedtext_not_json", url, status: res.status, ct, bytes: body.length, head },
    };
  }

  let json: any;
  try {
    json = JSON.parse(body);
  } catch (e: any) {
    return {
      transcript: null,
      debug: {
        step: "timedtext_json_parse_failed",
        url,
        status: res.status,
        ct,
        bytes: body.length,
        head,
        parseError: String(e?.message || e),
      },
    };
  }

  const events = Array.isArray(json?.events) ? json.events : [];
  const parts: string[] = [];
  for (const ev of events) {
    const segs = Array.isArray(ev?.segs) ? ev.segs : [];
    for (const s of segs) {
      const t = typeof s?.utf8 === "string" ? s.utf8 : "";
      if (t) parts.push(t);
    }
  }

  const transcript = parts.join("").replace(/\s+/g, " ").trim() || null;
  return {
    transcript,
    debug: { step: "timedtext_ok", url, status: res.status, ct, bytes: body.length },
  };
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);

  const vid = extractVideoId(searchParams.get("v"));
  const debugOn = searchParams.get("debug") === "1";
  const lang = searchParams.get("lang") || "ko";

  if (!vid) {
    const out: ApiOut = { transcript: null, reason: "BAD_REQUEST", error: "Missing/invalid v" };
    return NextResponse.json(out, { status: 400 });
  }

  // 1) fetch watch HTML
  const watchUrl = `https://www.youtube.com/watch?v=${vid}&hl=${encodeURIComponent(lang)}`;
  const watchRes = await fetch(watchUrl, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "accept-language": "en-US,en;q=0.9,ko;q=0.8",
    },
    cache: "no-store",
  });

  const html = await safeText(watchRes);

  // 2) extract ytInitialPlayerResponse safely (brace matching)
  const player =
    findBalancedJsonAfter(html, "var ytInitialPlayerResponse =") ||
    findBalancedJsonAfter(html, "ytInitialPlayerResponse =") ||
    null;

  if (!player) {
    const out: ApiOut = {
      transcript: null,
      reason: "CAPTION_FETCH_FAILED",
      strategy: "ytInitialPlayerResponse",
      error: "Could not parse ytInitialPlayerResponse from watch HTML",
      debug: debugOn
        ? { step: "watch_fetch", watchUrl, status: watchRes.status, bytes: html.length, head: html.slice(0, 200) }
        : undefined,
    };
    return NextResponse.json(out);
  }

  const description = extractDescriptionFromPlayerResponse(player);

  // 3) caption baseUrl from captionTracks
  const { url: baseUrl, chosen } = extractCaptionBaseUrl(player, lang);

  if (!baseUrl) {
    const out: ApiOut = {
      transcript: null,
      reason: "NO_CAPTIONS",
      description,
      strategy: "captionTracks_missing",
      debug: debugOn ? { step: "no_tracks", chosenTrack: chosen ?? null } : undefined,
    };
    return NextResponse.json(out);
  }

  // 4) fetch transcript json3
  const t = await fetchTranscriptFromBaseUrl(baseUrl);

  if (!t.transcript) {
    const out: ApiOut = {
      transcript: null,
      reason: "CAPTION_FETCH_FAILED",
      description,
      strategy: "timedtext_json3",
      error: null,
      debug: debugOn ? { chosenTrack: chosen, ...t.debug } : undefined,
    };
    return NextResponse.json(out);
  }

  const out: ApiOut = {
    transcript: t.transcript,
    reason: null,
    description,
    strategy: "ytInitialPlayerResponse.captionTracks",
    debug: debugOn ? { chosenTrack: chosen, ...t.debug } : undefined,
  };

  return NextResponse.json(out);
}
