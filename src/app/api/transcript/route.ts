import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Track = { baseUrl: string; kind?: string; languageCode?: string; vssId?: string; name?: any };

const CAPTION_HEADERS: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36",
  "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9,ko;q=0.8",
  "cache-control": "no-cache",
  pragma: "no-cache",
};

function withQuery(url: string, q: Record<string, string | undefined>) {
  const u = new URL(url);
  for (const [k, v] of Object.entries(q)) {
    if (v == null || v === "") continue;
    u.searchParams.set(k, v);
  }
  return u.toString();
}

function cleanupTranscript(input: string) {
  let s = input || "";
  s = s.replace(/\r\n/g, "\n");
  s = s.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ");
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n{3,}/g, "\n\n");
  const oneLine = s.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
  return { oneLine, raw: s.trim() };
}

/** ===== Caption parsers ===== */

function decodeXmlEntities(s: string) {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseCaptionXml(xml: string): string[] {
  // extracts <text ...>...</text>
  const out: string[] = [];
  const re = /<text[^>]*>([\s\S]*?)<\/text>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const t = decodeXmlEntities(m[1] || "").replace(/\s+/g, " ").trim();
    if (t) out.push(t);
  }
  return out;
}

function parseCaptionJson3(jsonText: string): string[] {
  try {
    const data = JSON.parse(jsonText) as any;
    const events = Array.isArray(data?.events) ? data.events : [];
    const out: string[] = [];
    for (const ev of events) {
      const segs = Array.isArray(ev?.segs) ? ev.segs : [];
      const line = segs
        .map((x: any) => (typeof x?.utf8 === "string" ? x.utf8 : ""))
        .join("")
        .replace(/\n/g, " ")
        .trim();
      if (line) out.push(line);
    }
    return out;
  } catch {
    return [];
  }
}

/** ✅ XML(<text>)든 JSON3든 둘 다 처리 */
function parseCaptionAny(payload: string): string | null {
  const s = payload.trim();

  // XML
  if (s.includes("<text") && s.includes("</text>")) {
    const segs = parseCaptionXml(s);
    return segs.length ? segs.join("\n") : null;
  }

  // JSON3
  if (s.startsWith("{")) {
    const segs = parseCaptionJson3(s);
    return segs.length ? segs.join("\n") : null;
  }

  // HTML(차단/동의/리디렉트 등)
  if (s.startsWith("<!DOCTYPE") || s.startsWith("<html")) return null;

  return null;
}

async function fetchCaptionFromTracks(
  tracks: Array<{ baseUrl: string; kind?: string }>,
  tlang?: string,
  debug?: any
): Promise<string | null> {
  const manual = tracks.find((t) => t.kind !== "asr");
  const track = manual ?? tracks[0];
  if (!track?.baseUrl) return null;

  // ✅ fmt는 json3로 먼저 시도 (제일 안정적)
  const urlJson3 = withQuery(track.baseUrl, {
    fmt: "json3",
    ...(tlang ? { tlang } : {}),
  });

  let res = await fetch(urlJson3, {
    headers: CAPTION_HEADERS,
    redirect: "follow",
    cache: "no-store",
  });

  const ct1 = res.headers.get("content-type") || "";
  const body1 = await res.text();

  debug && (debug.timedtext_json3 = {
    url: urlJson3,
    status: res.status,
    contentType: ct1,
    bytes: body1.length,
    head: body1.slice(0, 200),
  });

  if (res.ok && body1.length > 20) {
    const text = parseCaptionAny(body1);
    if (text) return text;
  }

  // ✅ json3가 막혔거나 비면 srv3(XML)도 한 번 더
  const urlSrv3 = withQuery(track.baseUrl, {
    fmt: "srv3",
    ...(tlang ? { tlang } : {}),
  });

  res = await fetch(urlSrv3, {
    headers: CAPTION_HEADERS,
    redirect: "follow",
    cache: "no-store",
  });

  const ct2 = res.headers.get("content-type") || "";
  const body2 = await res.text();

  debug && (debug.timedtext_srv3 = {
    url: urlSrv3,
    status: res.status,
    contentType: ct2,
    bytes: body2.length,
    head: body2.slice(0, 200),
  });

  if (!res.ok || body2.length < 20) return null;

  const text2 = parseCaptionAny(body2);
  return text2;
}

/** ===== Track extraction from watch html =====
 * 최소 버전: watch HTML에서 "captionTracks" JSON 블록만 뽑아냄
 */
function extractCaptionTracksFromWatchHtml(html: string): Track[] {
  const key = '"captionTracks":';
  const i = html.indexOf(key);
  if (i < 0) return [];
  // captionTracks: [ ... ]
  const start = html.indexOf("[", i);
  if (start < 0) return [];
  let depth = 0;
  let end = -1;
  for (let p = start; p < html.length; p++) {
    const ch = html[p];
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) {
        end = p + 1;
        break;
      }
    }
  }
  if (end < 0) return [];
  const arrText = html.slice(start, end);
  try {
    const arr = JSON.parse(arrText) as any[];
    return (arr || []).filter((t) => t?.baseUrl);
  } catch {
    return [];
  }
}

/** ===== HTTP handlers ===== */

// GET: v 파라미터로 YouTube watch -> captionTracks -> timedtext fetch
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const v = searchParams.get("v") || "";
  const tlang = searchParams.get("tlang") || undefined;
  const debugOn = searchParams.get("debug") === "1";

  if (!v) {
    return NextResponse.json({ transcript: null, reason: "MISSING_VIDEO_ID" }, { status: 400 });
  }

  const debug: any = debugOn ? { step: "start" } : null;

  try {
    debug && (debug.step = "fetch_watch");
    const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(v)}`;
    const watchRes = await fetch(watchUrl, {
      headers: {
        ...CAPTION_HEADERS,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      },
      redirect: "follow",
      cache: "no-store",
    });
    const watchHtml = await watchRes.text();

    debug && (debug.watch = {
      status: watchRes.status,
      contentType: watchRes.headers.get("content-type") || "",
      bytes: watchHtml.length,
      finalUrl: watchRes.url,
    });

    debug && (debug.step = "extract_tracks");
    const tracks = extractCaptionTracksFromWatchHtml(watchHtml);
    debug && (debug.trackCount = tracks.length);

    if (!tracks.length) {
      return NextResponse.json(
        { transcript: null, reason: "NO_CAPTIONS", strategy: "watch_html", debug },
        { status: 200 }
      );
    }

    debug && (debug.step = "fetch_timedtext");
    const text = await fetchCaptionFromTracks(
      tracks.map((t) => ({ baseUrl: t.baseUrl, kind: t.kind })),
      tlang,
      debug
    );

    if (!text) {
      return NextResponse.json(
        {
          transcript: null,
          reason: "CAPTION_FETCH_FAILED",
          strategy: "timedtext_json3_srv3",
          error: "timedtext blocked/expired/consent (often returns 0 bytes html)",
          debug,
        },
        { status: 200 }
      );
    }

    return NextResponse.json(
      { transcript: text, reason: null, strategy: "timedtext_json3_srv3", debug },
      { status: 200 }
    );
  } catch (e: any) {
    return NextResponse.json(
      { transcript: null, reason: "INTERNAL_ERROR", error: String(e?.message || e), debug },
      { status: 500 }
    );
  }
}

// POST: transcript 텍스트를 받아서 정리만 수행
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const transcript = typeof body?.transcript === "string" ? body.transcript : "";
    if (!transcript.trim()) {
      return NextResponse.json({ transcript: null, reason: "EMPTY_INPUT" }, { status: 400 });
    }
    const cleaned = cleanupTranscript(transcript);
    return NextResponse.json({
      transcript: cleaned.oneLine,
      transcript_raw: cleaned.raw,
      reason: null,
    });
  } catch (e: any) {
    return NextResponse.json(
      { transcript: null, reason: "BAD_REQUEST", error: String(e?.message || e) },
      { status: 400 }
    );
  }
}
