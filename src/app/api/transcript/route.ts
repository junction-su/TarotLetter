async function fetchCaptionFromTracks(
  tracks: Array<{ baseUrl: string; kind?: string }>,
  tlang?: string,
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

  console.log("[caption] status", res.status);
  console.log("[caption] content-type", ct1);
  console.log("[caption] url(head)", urlJson3.slice(0, 140));
  console.log("[caption] bytes", body1.length);
  console.log("[caption] head", body1.slice(0, 200));

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

  console.log("[caption2] status", res.status);
  console.log("[caption2] content-type", ct2);
  console.log("[caption2] url(head)", urlSrv3.slice(0, 140));
  console.log("[caption2] bytes", body2.length);
  console.log("[caption2] head", body2.slice(0, 200));

  if (!res.ok || body2.length < 20) return null;

  const text2 = parseCaptionAny(body2);
  return text2;
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
