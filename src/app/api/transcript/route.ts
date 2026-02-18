import { NextResponse } from "next/server";

type Debug = Record<string, any>;

function pickHeader(map: Headers, key: string) {
  const v = map.get(key);
  return v == null ? null : v;
}

function extractPlayerResponse(html: string): any | null {
  // ytInitialPlayerResponse = {...};
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
  // minimal unescape
  return m[1]
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parseSetCookieToCookieHeader(setCookies: string[]): string {
  // keep only "name=value"
  const pairs: string[] = [];
  for (const sc of setCookies) {
    const first = sc.split(";")[0]?.trim();
    if (first) pairs.push(first);
  }
  // de-dup by cookie name
  const seen = new Map<string, string>();
  for (const p of pairs) {
    const eq = p.indexOf("=");
    const name = eq >= 0 ? p.slice(0, eq) : p;
    seen.set(name, p);
  }
  return Array.from(seen.values()).join("; ");
}

async function fetchWithContext(
  url: string,
  ctx: {
    cookie?: string;
    referer?: string;
    origin?: string;
    accept?: string;
    extraHeaders?: Record<string, string>;
  },
  debug: Debug,
  debugKey: string
) {
  const headers: Record<string, string> = {
    "user-agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36",
    accept: ctx.accept ?? "*/*",
    "accept-language": "en-US,en;q=0.9,ko;q=0.8",
  };
  if (ctx.cookie) headers.cookie = ctx.cookie;
  if (ctx.referer) headers.referer = ctx.referer;
  if (ctx.origin) headers.origin = ctx.origin;
  if (ctx.extraHeaders) Object.assign(headers, ctx.extraHeaders);

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
    head: buf.slice(0, 80).toString("utf8"),
  };

  return { res, buf, bytes, contentType };
}

function isBlockedEmptyHtml(bytes: number, contentType: string) {
  return bytes === 0 && contentType.toLowerCase().includes("text/html");
}

function timedtextUrlWithFmt(baseUrl: string, fmt: string | null) {
  const u = new URL(baseUrl);
  if (fmt) u.searchParams.set("fmt", fmt);
  else u.searchParams.delete("fmt");
  return u.toString();
}

function vttToText(vtt: string) {
  // remove WEBVTT header + cue timings + numeric indices
  const lines = vtt.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (t === "WEBVTT") continue;
    if (/^\d+$/.test(t)) continue;
    if (/^\d\d:\d\d:\d\d\.\d\d\d\s-->\s\d\d:\d\d:\d\d\.\d\d\d/.test(t)) continue;
    if (/^NOTE\b/.test(t)) continue;
    // strip tags
    out.push(t.replace(/<[^>]+>/g, ""));
  }
  // de-dupe consecutive duplicates
  const dedup: string[] = [];
  for (const s of out) {
    if (dedup.length === 0 || dedup[dedup.length - 1] !== s) dedup.push(s);
  }
  return dedup.join(" ");
}

function xmlToText(xml: string) {
  // <text start="..." dur="...">...</text>
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
  // de-dupe consecutive duplicates
  const dedup: string[] = [];
  for (const s of out) {
    if (dedup.length === 0 || dedup[dedup.length - 1] !== s) dedup.push(s);
  }
  return dedup.join(" ");
}

function json3ToText(json: any) {
  // json.events[].segs[].utf8
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
  // de-dupe consecutive duplicates
  const dedup: string[] = [];
  for (const s of out) {
    if (dedup.length === 0 || dedup[dedup.length - 1] !== s) dedup.push(s);
  }
  return dedup.join(" ");
}

function chooseTrack(tracks: any[], tlang?: string | null) {
  // prefer non-ASR if exists, then ASR. Prefer exact language if provided.
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

export async function GET(req: Request) {
  const url = new URL(req.url);
  const v = url.searchParams.get("v")?.trim();
  const tlang = url.searchParams.get("tlang"); // optional: "en" etc
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

    // 1) Fetch watch page to obtain cookies + player response
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
    const cookieHeader = parseSetCookieToCookieHeader(setCookie);

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

    // 2) Try timedtext in multiple formats with proper context headers
    const referer = watchUrl;
    const origin = "https://www.youtube.com";

    const attempts: Array<{ fmt: string | null; parse: (s: string) => string; name: string; accept: string }> =
      [
        { fmt: "vtt", name: "timedtext_vtt", accept: "text/vtt,*/*;q=0.8", parse: vttToText },
        { fmt: "srv3", name: "timedtext_srv3", accept: "text/xml,*/*;q=0.8", parse: xmlToText },
        { fmt: null, name: "timedtext_xml", accept: "text/xml,*/*;q=0.8", parse: xmlToText },
        {
          fmt: "json3",
          name: "timedtext_json3",
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

      const timedUrl = timedtextUrlWithFmt(String(chosen.baseUrl), a.fmt);
      const { buf, bytes, contentType } = await fetchWithContext(
        timedUrl,
        {
          cookie: cookieHeader,
          referer,
          origin,
          accept: a.accept,
          extraHeaders: {
            // This helps with some YouTube edge cases
            "sec-fetch-site": "same-site",
            "sec-fetch-mode": "cors",
            "sec-fetch-dest": "empty",
          },
        },
        debug,
        "timedtext"
      );

      if (isBlockedEmptyHtml(bytes, contentType)) {
        // Try next format
        continue;
      }

      const body = buf.toString("utf8").trim();
      if (!body) continue;

      // If YouTube returns an HTML consent page or similar, skip
      if (body.startsWith("<!DOCTYPE html") || body.startsWith("<html")) {
        continue;
      }

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

    // If all timedtext attempts failed, return a meaningful error
    return NextResponse.json({
      transcript: null,
      reason: "CAPTION_FETCH_FAILED",
      description: description ?? null,
      strategy: "timedtext_multi_fmt",
      error: "timedtext body is 0 bytes or non-caption HTML (blocked/consent)",
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
