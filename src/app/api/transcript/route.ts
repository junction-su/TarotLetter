import { NextResponse } from "next/server";

type Debug = Record<string, any>;

function extractPlayerResponse(html: string): any | null {
  const m =
    html.match(/ytInitialPlayerResponse\s*=\s*(\{.*?\})\s*;\s*/s) ||
    html.match(/var\s+ytInitialPlayerResponse\s*=\s*(\{.*?\})\s*;\s*/s);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

function extractDescription(html: string): string | null {
  const m = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i);
  if (!m) return null;
  return m[1]
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parseSetCookieToCookieHeader(setCookies: string[]): string {
  const pairs: string[] = [];
  for (const sc of setCookies) {
    const first = sc.split(";")[0]?.trim();
    if (first) pairs.push(first);
  }
  const seen = new Map<string, string>();
  for (const p of pairs) {
    const eq = p.indexOf("=");
    const name = eq >= 0 ? p.slice(0, eq) : p;
    seen.set(name, p);
  }
  return Array.from(seen.values()).join("; ");
}

function ensureConsentCookies(cookieHeader: string) {
  // YouTube sometimes returns 200 + 0 bytes for timedtext unless consent cookies exist.
  // Add CONSENT/SOCS if missing.
  const hasConsent = /(?:^|;\s*)CONSENT=/.test(cookieHeader);
  const hasSocs = /(?:^|;\s*)SOCS=/.test(cookieHeader);

  const extra: string[] = [];
  if (!hasConsent) extra.push("CONSENT=YES+1");
  if (!hasSocs) extra.push("SOCS=CAI");

  return extra.length ? [cookieHeader, ...extra].filter(Boolean).join("; ") : cookieHeader;
}

async function fetchWithContext(
  url: string,
  ctx: {
    cookie?: string;
    referer?: string;
    origin?: string;
    accept?: string;
  },
  debug: Debug,
  debugKey: string
) {
  const headers: Record<string, string> = {
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
    accept: ctx.accept ?? "*/*",
    "accept-language": "en-US,en;q=0.9,ko;q=0.8",
    // These two help some edge cases where YouTube expects browser-like fetch:
    "sec-fetch-site": "same-site",
    "sec-fetch-mode": "cors",
    "sec-fetch-dest": "empty",
  };

  if (ctx.cookie) headers.cookie = ctx.cookie;
  if (ctx.referer) headers.referer = ctx.referer;
  if (ctx.origin) headers.origin = ctx.origin;

  const res = await fetch(url, {
    method: "GET",
    headers,
    redirect: "follow",
    cache: "no-store",
  });

  const contentType = res.headers.get("content-type") || "";
  const contentLength = res.headers.get("content-length") || null;

  const buf = Buffer.from(await res.arrayBuffer());
  const bytes = buf.length;

  debug[debugKey] = {
    status: res.status,
    contentType,
    contentLength,
    redirected: res.redirected,
    finalUrl: res.url,
    bytes,
    head: buf.slice(0, 120).toString("utf8"),
  };

  return { res, buf, bytes, contentType };
}

function isBlockedZero(bytes: number, contentType: string) {
  return bytes === 0 && contentType.toLowerCase().includes("text/html");
}

function timedtextUrlWithFmt(baseUrl: string, fmt: string | null) {
  const u = new URL(baseUrl);
  if (fmt) u.searchParams.set("fmt", fmt);
  else u.searchParams.delete("fmt");
  return u.toString();
}

function vttToText(vtt: string) {
  const lines = vtt.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t === "WEBVTT") continue;
    if (/^\d+$/.test(t)) continue;
    if (/^\d\d:\d\d:\d\d\.\d\d\d\s-->\s\d\d:\d\d:\d\d\.\d\d\d/.test(t)) continue;
    if (/^NOTE\b/.test(t)) continue;
    out.push(t.replace(/<[^>]+>/g, ""));
  }
  const dedup: string[] = [];
  for (const s of out) {
    if (dedup.length === 0 || dedup[dedup.length - 1] !== s) dedup.push(s);
  }
  return dedup.join(" ");
}

function xmlToText(xml: string) {
  const out: string[] = [];
  const re = /<text\b[^>]*>([\s\S]*?)<\/text>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const raw = m[1]
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (raw) out.push(raw);
  }
  const dedup: string[] = [];
  for (const s of out) {
    if (dedup.length === 0 || dedup[dedup.length - 1] !== s) dedup.push(s);
  }
  return dedup.join(" ");
}

function json3ToText(json: any) {
  const out: string[] = [];
  const events = Array.isArray(json?.events) ? json.events : [];
  for (const ev of events) {
    const segs = Array.isArray(ev?.segs) ? ev.segs : [];
    for (const seg of segs) {
      const t = typeof seg?.utf8 === "string" ? seg.utf8 : "";
      const cleaned = t.replace(/\s+/g, " ").trim();
      if (cleaned) out.push(cleaned);
    }
  }
  const dedup: string[] = [];
  for (const s of out) {
    if (dedup.length === 0 || dedup[dedup.length - 1] !== s) dedup.push(s);
  }
  return dedup.join(" ");
}

function chooseTrack(tracks: any[], tlang?: string | null) {
  const list = tracks.filter(Boolean);
  if (list.length === 0) return null;

  const lang = (tlang || "").trim().toLowerCase();
  const byLang = lang
    ? list.filter((t) => String(t.languageCode || "").toLowerCase() === lang)
    : list;

  const nonAsr = byLang.find((t) => !String(t.vssId || "").startsWith("a."));
  const asr = byLang.find((t) => String(t.vssId || "").startsWith("a."));

  return nonAsr || asr || list[0] || null;
}

function buildVideoGoogleTimedtextUrl(videoId: string, lang: string, fmt: "vtt" | "srv3" | "xml") {
  const u = new URL("https://video.google.com/timedtext");
  u.searchParams.set("v", videoId);
  u.searchParams.set("lang", lang);
  if (fmt === "vtt") u.searchParams.set("fmt", "vtt");
  if (fmt === "srv3") u.searchParams.set("fmt", "srv3");
  // xml: omit fmt
  return u.toString();
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const v = url.searchParams.get("v")?.trim();
  const tlang = url.searchParams.get("tlang"); // optional
  const debugOn = url.searchParams.get("debug") === "1";

  const debug: Debug = { step: "start" };

  if (!v) {
    return NextResponse.json(
      { transcript: null, reason: "MISSING_VIDEO_ID" },
      { status: 400 }
    );
  }

  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(v)}`;

  try {
    debug.step = "fetch_watch";

    const watchRes = await fetch(watchUrl, {
      method: "GET",
      redirect: "follow",
      cache: "no-store",
      headers: {
        "user-agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9,ko;q=0.8",
      },
    });

    const watchHtml = await watchRes.text();
    const setCookie = watchRes.headers.getSetCookie?.() ?? [];
    let cookieHeader = parseSetCookieToCookieHeader(setCookie);
    cookieHeader = ensureConsentCookies(cookieHeader);

    debug.watch = {
      status: watchRes.status,
      contentType: watchRes.headers.get("content-type"),
      contentLength: watchRes.headers.get("content-length"),
      redirected: watchRes.redirected,
      finalUrl: watchRes.url,
      bytes: Buffer.byteLength(watchHtml, "utf8"),
    };
    debug.cookies = {
      setCookieCount: setCookie.length,
      cookieLen: cookieHeader.length,
    };

    const player = extractPlayerResponse(watchHtml);
    const description = extractDescription(watchHtml);

    if (!player) {
      return NextResponse.json({
        transcript: null,
        reason: "PLAYER_RESPONSE_NOT_FOUND",
        description: description ?? null,
        strategy: null,
        ...(debugOn ? { debug } : {}),
      });
    }

    const tracks =
      player?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];

    if (!Array.isArray(tracks) || tracks.length === 0) {
      return NextResponse.json({
        transcript: null,
        reason: "NO_CAPTIONS",
        description: description ?? null,
        strategy: null,
        ...(debugOn ? { debug } : {}),
      });
    }

    const chosen = chooseTrack(tracks, tlang);
    if (!chosen?.baseUrl) {
      return NextResponse.json({
        transcript: null,
        reason: "NO_CAPTION_TRACK_URL",
        description: description ?? null,
        strategy: null,
        ...(debugOn ? { debug } : {}),
      });
    }

    debug.chosenTrack = {
      languageCode: chosen.languageCode,
      vssId: chosen.vssId,
      name: chosen.name,
      baseUrlLen: String(chosen.baseUrl).length,
      baseUrlHead: String(chosen.baseUrl).slice(0, 250),
      baseUrlTail: String(chosen.baseUrl).slice(-250),
    };

    const referer = watchUrl;
    const origin = "https://www.youtube.com";

    // 1) Primary: youtube.com/api/timedtext via baseUrl (multi-format)
    const attempts: Array<{
      name: string;
      url: string;
      accept: string;
      parse: (s: string) => string;
    }> = [
      {
        name: "yt_timedtext_vtt",
        url: timedtextUrlWithFmt(String(chosen.baseUrl), "vtt"),
        accept: "text/vtt,*/*;q=0.8",
        parse: vttToText,
      },
      {
        name: "yt_timedtext_srv3",
        url: timedtextUrlWithFmt(String(chosen.baseUrl), "srv3"),
        accept: "text/xml,*/*;q=0.8",
        parse: xmlToText,
      },
      {
        name: "yt_timedtext_xml",
        url: timedtextUrlWithFmt(String(chosen.baseUrl), null),
        accept: "text/xml,*/*;q=0.8",
        parse: xmlToText,
      },
      {
        name: "yt_timedtext_json3",
        url: timedtextUrlWithFmt(String(chosen.baseUrl), "json3"),
        accept: "application/json,text/plain,*/*",
        parse: (s: string) => {
          try {
            return json3ToText(JSON.parse(s));
          } catch {
            return "";
          }
        },
      },
    ];

    for (const a of attempts) {
      debug.step = `fetch_${a.name}`;
      const { buf, bytes, contentType } = await fetchWithContext(
        a.url,
        { cookie: cookieHeader, referer, origin, accept: a.accept },
        debug,
        "timedtext"
      );

      if (isBlockedZero(bytes, contentType)) continue;

      const body = buf.toString("utf8").trim();
      if (!body) continue;
      if (body.startsWith("<!DOCTYPE html") || body.startsWith("<html")) continue;

      const text = a.parse(body).replace(/\s+/g, " ").trim();
      if (text.length > 0) {
        return NextResponse.json({
          transcript: text,
          reason: null,
          description: description ?? null,
          strategy: a.name,
          error: null,
          ...(debugOn ? { debug } : {}),
        });
      }
    }

    // 2) Fallback: video.google.com/timedtext (often works when youtube.com/api/timedtext is blocked)
    const lang =
      (tlang && tlang.trim()) ||
      (chosen.languageCode ? String(chosen.languageCode) : "en");

    const legacyAttempts: Array<{
      name: string;
      url: string;
      accept: string;
      parse: (s: string) => string;
    }> = [
      {
        name: "video_google_vtt",
        url: buildVideoGoogleTimedtextUrl(v, lang, "vtt"),
        accept: "text/vtt,*/*;q=0.8",
        parse: vttToText,
      },
      {
        name: "video_google_srv3",
        url: buildVideoGoogleTimedtextUrl(v, lang, "srv3"),
        accept: "text/xml,*/*;q=0.8",
        parse: xmlToText,
      },
      {
        name: "video_google_xml",
        url: buildVideoGoogleTimedtextUrl(v, lang, "xml"),
        accept: "text/xml,*/*;q=0.8",
        parse: xmlToText,
      },
    ];

    for (const a of legacyAttempts) {
      debug.step = `fetch_${a.name}`;
      const { buf, bytes, contentType } = await fetchWithContext(
        a.url,
        {
          // legacy endpoint usually works without cookies, but keep them anyway
          cookie: cookieHeader,
          referer,
          origin: "https://video.google.com",
          accept: a.accept,
        },
        debug,
        "timedtext_legacy"
      );

      if (isBlockedZero(bytes, contentType)) continue;

      const body = buf.toString("utf8").trim();
      if (!body) continue;
      if (body.startsWith("<!DOCTYPE html") || body.startsWith("<html")) continue;

      const text = a.parse(body).replace(/\s+/g, " ").trim();
      if (text.length > 0) {
        return NextResponse.json({
          transcript: text,
          reason: null,
          description: description ?? null,
          strategy: a.name,
          error: null,
          ...(debugOn ? { debug } : {}),
        });
      }
    }

    return NextResponse.json({
      transcript: null,
      reason: "CAPTION_FETCH_FAILED",
      description: description ?? null,
      strategy: "timedtext_multi_fmt_plus_legacy",
      error: "timedtext returned 0 bytes (likely consent/bot blocking). Tried youtube.com + video.google.com.",
      ...(debugOn ? { debug } : {}),
    });
  } catch (e: any) {
    return NextResponse.json({
      transcript: null,
      reason: "CAPTION_FETCH_FAILED",
      error: String(e?.message || e),
      ...(debugOn ? { debug } : {}),
    });
  }
}
