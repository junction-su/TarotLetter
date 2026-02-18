/* eslint-disable @typescript-eslint/no-explicit-any */
import { NextResponse } from "next/server";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

type OkResult = {
  transcript: string;
  reason: null;
  description: string | null;
  strategy: "timedtext_json3" | "timedtext_srv3" | "youtubei_player";
};

type FailResult = {
  transcript: null;
  reason:
    | "MISSING_VIDEO_ID"
    | "NO_CAPTIONS"
    | "CAPTION_FETCH_FAILED"
    | "VIDEO_UNAVAILABLE";
  description: string | null;
  strategy: null | "timedtext_json3" | "timedtext_srv3" | "youtubei_player";
  error?: string;
};

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const videoId = (searchParams.get("v") || "").trim();
  const tlang = (searchParams.get("tlang") || "").trim(); // optional: translate target language

  if (!videoId) {
    return NextResponse.json<FailResult>({
      transcript: null,
      reason: "MISSING_VIDEO_ID",
      description: null,
      strategy: null,
    });
  }

  // 1) description(영상 설명) - 실패해도 OK
  const description = await tryGetDescription(videoId).catch(() => null);

  try {
    // A) timedtext json3
    const t1 = await tryTimedtextJson3(videoId, tlang);
    if (t1) {
      return NextResponse.json<OkResult>({
        transcript: t1,
        reason: null,
        description,
        strategy: "timedtext_json3",
      });
    }

    // B) timedtext srv3 (xml)
    const t2 = await tryTimedtextSrv3(videoId, tlang);
    if (t2) {
      return NextResponse.json<OkResult>({
        transcript: t2,
        reason: null,
        description,
        strategy: "timedtext_srv3",
      });
    }

    // C) youtubei_player (pb3)
    const t3 = await tryYoutubeiPlayerPb3(videoId, tlang);
    if (t3) {
      return NextResponse.json<OkResult>({
        transcript: t3,
        reason: null,
        description,
        strategy: "youtubei_player",
      });
    }

    return NextResponse.json<FailResult>({
      transcript: null,
      reason: "NO_CAPTIONS",
      description,
      strategy: null,
    });
  } catch (e: any) {
    return NextResponse.json<FailResult>({
      transcript: null,
      reason: "CAPTION_FETCH_FAILED",
      description,
      strategy: null,
      error: String(e?.message || e),
    });
  }
}

/* -----------------------------
   Helpers
-------------------------------- */

async function fetchText(url: string, init?: RequestInit) {
  const res = await fetch(url, {
    ...init,
    headers: { "User-Agent": UA, ...(init?.headers || {}) },
    redirect: "follow",
    cache: "no-store",
  });
  const text = await res.text(); // 항상 text로 받기
  return { res, text };
}

function safeJsonParse(raw: string) {
  const s = raw?.trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function decodeEntities(s: string) {
  return s
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

function cleanLine(s: string) {
  return s
    .replace(/\s+/g, " ")
    .replace(/\u200b/g, "")
    .trim();
}

/** json3: events[].segs[].utf8 */
function parseJson3(json: any): string[] {
  const out: string[] = [];
  const events = json?.events;
  if (!Array.isArray(events)) return out;

  for (const ev of events) {
    const segs = ev?.segs;
    if (!Array.isArray(segs)) continue;
    let line = "";
    for (const seg of segs) {
      const t = seg?.utf8;
      if (typeof t === "string") line += t;
    }
    line = cleanLine(line);
    if (line) out.push(line);
  }
  return out;
}

/** srv3 xml: <text>...</text> */
function parseCaptionXml(xmlText: string): string[] {
  const out: string[] = [];
  if (!xmlText) return out;

  const regex = /<text\b[^>]*>([\s\S]*?)<\/text>/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(xmlText)) !== null) {
    const raw = decodeEntities(m[1] || "");
    const line = cleanLine(raw.replace(/\n/g, " "));
    if (line) out.push(line);
  }
  return out;
}

/* -----------------------------
   A) timedtext fmt=json3
-------------------------------- */
async function tryTimedtextJson3(videoId: string, tlang?: string): Promise<string | null> {
  const langs = ["ko", "en", "ja", "es"];

  for (const lang of langs) {
    // manual
    {
      const url =
        `https://www.youtube.com/api/timedtext?v=${videoId}` +
        `&lang=${encodeURIComponent(lang)}` +
        `&fmt=json3` +
        (tlang ? `&tlang=${encodeURIComponent(tlang)}` : "");
      const { res, text } = await fetchText(url);
      if (!res.ok) continue;
      const json = safeJsonParse(text);
      if (!json) continue;

      const segs = parseJson3(json);
      if (segs.length) return segs.join("\n");
    }

    // auto(asr)
    {
      const url =
        `https://www.youtube.com/api/timedtext?v=${videoId}` +
        `&lang=${encodeURIComponent(lang)}` +
        `&kind=asr` +
        `&fmt=json3` +
        (tlang ? `&tlang=${encodeURIComponent(tlang)}` : "");
      const { res, text } = await fetchText(url);
      if (!res.ok) continue;
      const json = safeJsonParse(text);
      if (!json) continue;

      const segs = parseJson3(json);
      if (segs.length) return segs.join("\n");
    }
  }

  return null;
}

/* -----------------------------
   B) timedtext fmt=srv3 (xml)
-------------------------------- */
async function tryTimedtextSrv3(videoId: string, tlang?: string): Promise<string | null> {
  const langs = ["ko", "en", "ja", "es"];

  for (const lang of langs) {
    // manual
    {
      const url =
        `https://www.youtube.com/api/timedtext?v=${videoId}` +
        `&lang=${encodeURIComponent(lang)}` +
        `&fmt=srv3` +
        (tlang ? `&tlang=${encodeURIComponent(tlang)}` : "");
      const { res, text } = await fetchText(url);
      if (!res.ok) continue;
      const segs = parseCaptionXml(text);
      if (segs.length) return segs.join("\n");
    }

    // auto(asr)
    {
      const url =
        `https://www.youtube.com/api/timedtext?v=${videoId}` +
        `&lang=${encodeURIComponent(lang)}` +
        `&kind=asr` +
        `&fmt=srv3` +
        (tlang ? `&tlang=${encodeURIComponent(tlang)}` : "");
      const { res, text } = await fetchText(url);
      if (!res.ok) continue;
      const segs = parseCaptionXml(text);
      if (segs.length) return segs.join("\n");
    }
  }

  return null;
}

/* -----------------------------
   C) youtubei_player pb3 timedtext
   - HTML에서 api/timedtext용 쿼리(ei, caps, ... )를 찾고,
     timedtext에 fmt=json3를 시도
-------------------------------- */
async function tryYoutubeiPlayerPb3(videoId: string, tlang?: string): Promise<string | null> {
  // 1) watch html 가져오기
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}&hl=ko`;
  const { res: watchRes, text: html } = await fetchText(watchUrl);
  if (!watchRes.ok || !html) return null;

  // 2) html에서 timedtext endpoint에 붙는 쿼리 파라미터를 대충 뽑기
  // 예: https://www.youtube.com/api/timedtext?v=...&ei=...&caps=asr&...&hl=ko&ip=0.0.0.0
  const m = html.match(/https:\/\/www\.youtube\.com\/api\/timedtext\?v=[^"\\]+/);
  if (!m?.[0]) return null;

  // 3) 기본 쿼리에 lang/kind/fmt/tlang만 바꿔서 호출
  const base = m[0];

  const langs = ["ko", "en", "ja", "es"];
  for (const lang of langs) {
    // manual json3
    {
      const url = replaceOrAppendParams(base, {
        lang,
        fmt: "json3",
        kind: undefined, // remove kind if exists
        ...(tlang ? { tlang } : {}),
      });
      const { res, text } = await fetchText(url);
      if (!res.ok) continue;

      // 200인데 빈 바디일 수 있음 -> safe parse
      const json = safeJsonParse(text);
      if (!json) continue;

      const segs = parseJson3(json);
      if (segs.length) return segs.join("\n");
    }

    // asr json3
    {
      const url = replaceOrAppendParams(base, {
        lang,
        fmt: "json3",
        kind: "asr",
        ...(tlang ? { tlang } : {}),
      });
      const { res, text } = await fetchText(url);
      if (!res.ok) continue;

      const json = safeJsonParse(text);
      if (!json) continue;

      const segs = parseJson3(json);
      if (segs.length) return segs.join("\n");
    }
  }

  return null;
}

function replaceOrAppendParams(urlStr: string, params: Record<string, string | undefined>) {
  const u = new URL(urlStr);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) {
      u.searchParams.delete(k);
    } else {
      u.searchParams.set(k, v);
    }
  }
  return u.toString();
}

/* -----------------------------
   Description fetch (best-effort)
-------------------------------- */
async function tryGetDescription(videoId: string): Promise<string | null> {
  const url = `https://www.youtube.com/watch?v=${videoId}&hl=ko`;
  const { res, text: html } = await fetchText(url);
  if (!res.ok || !html) return null;

  // 매우 러프하게 meta description 우선
  const md = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
  if (md?.[1]) return decodeEntities(md[1]).trim();

  return null;
}
