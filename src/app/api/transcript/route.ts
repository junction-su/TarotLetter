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

// watch HTML 안의 ytInitialPlayerResponse를 brace-matching으로 안전하게 파싱
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

function extractCaptionBaseUrl(player: any, langPref: string): { url: string | null; chosen?: any } {
  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!Array.isArray(tracks) || tracks.length === 0) return { url: null };

  const chosen =
    tracks.find((t: any) => t?.languageCode === langPref) ||
    tracks.find((t: any) => (t?.languageCode || "").startsWith(langPref)) ||
    tracks[0];

  const baseUrl = typeof chosen?.baseUrl === "string" ? chosen.baseUrl : null;
  return { url: baseUrl, chosen };
}

function vttToPlainText(vtt: string): string {
  // WEBVTT + timestamps 제거, 자막 텍스트만 합치기
  const lines = vtt.split(/\r?\n/);
  const out: string[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line === "WEBVTT") continue;
    if (/^\d+$/.test(line)) continue; // cue number
    if (line.includes("-->")) continue; // timestamp
    if (/^NOTE\b/i.test(line)) continue;

    // 간혹 <c> 태그, &amp; 같은 게 섞임
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

  // 중복 공백 정리
  return out.join(" ").replace(/\s+/g, " ").trim();
}

async function fetchTranscriptFromBaseUrl(baseUrl: string) {
  const headers = {
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    accept: "*/*",
    "accept-language": "en-US,en;q=0.9,ko;q=0.8",
  };

  // 1) VTT 우선 (가장 안정적)
  {
    const u = new URL(baseUrl);
    u.searchParams.set("fmt", "vtt");
    const url = u.toString();

    const res = await fetch(url, { headers, cache: "no-store" });
    const ct = res.headers.get("content-type");
    const body = await safeText(res);
    const head = body.slice(0, 200);

    if (res.ok && body.trim().startsWith("WEBVTT")) {
      const text = vttToPlainText(body);
      if (text) {
        return { transcript: text, debug: { step: "timedtext_vtt_ok", url, status: res.status, ct, bytes: body.length } };
      }
      return { transcript: null, debug: { step: "timedtext_vtt_empty", url, status: res.status, ct, bytes: body.length, head } };
    }

    // VTT 실패 디버그를 남기고 다음(json3)로
    var vttFail = { step: "timedtext_vtt_failed", url, status: res.status, ct, bytes: body.length, head };
  }

  // 2) JSON3 fallback (가끔 pb3로 오기도 해서 여기선 “최후 수단”)
  {
    const u = new URL(baseUrl);
    u.searchParams.set("fmt", "json3");
    const url = u.toString();

    const res = await fetch(url, { headers, cache: "no-store" });
    const ct = res.headers.get("content-type");
    const body = await safeText(res);
    const head = body.slice(0, 200);

    if (!res.ok || !body.trim()) {
      return { transcript: null, debug: { vttFail, step: "timedtext_json3_fetch_failed", url, status: res.status, ct, bytes: body.length, head } };
    }

    const first = body.trimStart()[0];
    if (!(first === "{" || first === "[")) {
      return { transcript: null, debug: { vttFail, step: "timedtext_json3_not_json", url, status: res.status, ct, bytes: body.length, head } };
    }

    let json: any;
    try {
      json = JSON.parse(body);
    } catch (e: any) {
      return {
        transcript: null,
        debug: {
          vttFail,
          step: "timedtext_json3_parse_failed",
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
    if (!transcript) {
      return { transcript: null, debug: { vttFail, step: "timedtext_json3_empty", url, status: res.status, ct, bytes: body.length, head, wireMagic: json?.wireMagic ?? null } };
    }

    return { transcript, debug: { vttFail, step: "timedtext_json3_ok", url, status: res.status, ct, bytes: body.length } };
  }
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

  const player =
    findBalancedJsonAfter(html, "var ytInitialPlayerResponse =") ||
    findBalancedJsonAfter(html, "ytInitialPlayerResponse =") ||
    null;

  if (!player) {
    const out: ApiOut = {
      transcript: null,
      reason: "CAPTION_FETCH_FAILED",
      strategy: "ytInitialPlayerResponse",
      error: "Could not parse ytInitialPlayerResponse",
      debug: debugOn ? { step: "watch_parse_failed", watchUrl, status: watchRes.status, bytes: html.length, head: html.slice(0, 200) } : undefined,
    };
    return NextResponse.json(out);
  }

  const description = extractDescription(player);
  const { url: baseUrl, chosen } = extractCaptionBaseUrl(player, lang);

  if (!baseUrl) {
    const out: ApiOut = {
      transcript: null,
      reason: "NO_CAPTIONS",
      description,
      strategy: "captionTracks_missing",
      debug: debugOn ? { step: "no_caption_tracks" } : undefined,
    };
    return NextResponse.json(out);
  }

  const t = await fetchTranscriptFromBaseUrl(baseUrl);

  if (!t.transcript) {
    const out: ApiOut = {
      transcript: null,
      reason: "CAPTION_FETCH_FAILED",
      description,
      strategy: "timedtext_vtt_then_json3",
      error: null,
      debug: debugOn ? { chosenTrack: chosen, ...t.debug } : undefined,
    };
    return NextResponse.json(out);
  }

  const out: ApiOut = {
    transcript: t.transcript,
    reason: null,
    description,
    strategy: "captionTracks.vtt",
    debug: debugOn ? { chosenTrack: chosen, ...t.debug } : undefined,
  };

  return NextResponse.json(out);
}
