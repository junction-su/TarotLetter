import { NextRequest, NextResponse } from "next/server";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const videoId = searchParams.get("v");

  if (!videoId) {
    return NextResponse.json({ transcript: null, reason: "NO_VIDEO_ID" });
  }

  try {
    const transcript =
      (await tryJson3Asr(videoId)) ||
      (await tryTimedtextXml(videoId));

    if (!transcript) {
      return NextResponse.json({
        transcript: null,
        reason: "NO_CAPTIONS",
      });
    }

    return NextResponse.json({
      transcript,
      reason: null,
    });
  } catch (e: any) {
    return NextResponse.json({
      transcript: null,
      reason: "CAPTION_FETCH_FAILED",
      error: e.message,
    });
  }
}

/* ------------------------------------------------ */
/* 1️⃣ JSON3 (자동 생성 자막) 시도 */
/* ------------------------------------------------ */

async function tryJson3Asr(videoId: string): Promise<string | null> {
  const url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=ko&kind=asr&fmt=json3`;

  const res = await fetch(url, {
    headers: { "User-Agent": UA },
    redirect: "follow",
    cache: "no-store",
  });

  if (!res.ok) return null;

  const json = await res.json();

  if (!json.events) return null;

  const lines: string[] = [];

  for (const e of json.events) {
    if (!e.segs) continue;

    const text = e.segs.map((s: any) => s.utf8).join("");
    if (text.trim()) lines.push(text.trim());
  }

  return cleanTranscript(lines.join(" "));
}

/* ------------------------------------------------ */
/* 2️⃣ XML fallback (수동 자막 대비) */
/* ------------------------------------------------ */

async function tryTimedtextXml(videoId: string): Promise<string | null> {
  const langs = ["ko", "en"];

  for (const lang of langs) {
    const url = `https://www.youtube.com/api/timedtext?v=${videoId}&lang=${lang}&fmt=srv3`;

    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      redirect: "follow",
      cache: "no-store",
    });

    if (!res.ok) continue;

    const xmlText = await res.text();
    if (!xmlText) continue;

    const segments = parseCaptionXml(xmlText);

    if (segments.length > 0) {
      return cleanTranscript(segments.join(" "));
    }
  }

  return null;
}

/* ------------------------------------------------ */
/* XML 파싱 */
/* ------------------------------------------------ */

function parseCaptionXml(xml: string): string[] {
  const matches = [...xml.matchAll(/<text[^>]*>(.*?)<\/text>/g)];
  return matches.map((m) =>
    decodeHtml(m[1])
      .replace(/\s+/g, " ")
      .trim()
  );
}

function decodeHtml(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

/* ------------------------------------------------ */
/* 🧹 후처리 (ASR 정리) */
/* ------------------------------------------------ */

function cleanTranscript(raw: string): string {
  if (!raw) return raw;

  let text = raw;

  // 1️⃣ 공백 정리
  text = text.replace(/\s+/g, " ").trim();

  // 2️⃣ 군더더기 단어 제거
  text = text.replace(/\b(자|음|어|이제|그|뭐)\b[,\s]*/g, "");

  // 3️⃣ 문장 단위 줄바꿈
  text = text.replace(/([.!?]|다\.)\s+/g, "$1\n");

  // 4️⃣ 중복 줄 제거
  const lines = text.split("\n").map((l) => l.trim());
  const deduped: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (i === 0 || lines[i] !== lines[i - 1]) {
      deduped.push(lines[i]);
    }
  }

  return deduped.join("\n").trim();
}
