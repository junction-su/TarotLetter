import { NextResponse } from "next/server";

function cleanupTranscript(input: string) {
  let s = input || "";

  // normalize newlines
  s = s.replace(/\r\n/g, "\n");

  // remove timestamps like 00:00, 01:05, 12:34
  s = s.replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ");

  // remove repeated spaces/newlines
  s = s.replace(/[ \t]+/g, " ");
  s = s.replace(/\n{3,}/g, "\n\n");

  // remove very long “description-like” blocks (optional heuristic)
  // If you don't want this, delete this block.
  // Many “NO_CAPTIONS” cases returned description instead of transcript.
  const lines = s.split("\n");
  const trimmedLines = lines.filter((l) => l.trim().length > 0);
  // If it looks like a description with lots of links/emoji/promo, keep only the first N lines
  const promoHits = (s.match(/https?:\/\/|📞|📲|구독|좋아요|tumblbug|예약/g) || []).length;
  if (promoHits >= 3 && trimmedLines.length > 30) {
    s = trimmedLines.slice(0, 30).join("\n");
  }

  // final single-line transcript (you can keep paragraphs if you want)
  const oneLine = s.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();

  return { oneLine, raw: s.trim() };
}

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const transcript = typeof body?.transcript === "string" ? body.transcript : "";
    const meta = body?.meta ?? null;

    if (!transcript.trim()) {
      return NextResponse.json(
        { transcript: null, reason: "EMPTY_INPUT", meta },
        { status: 400 }
      );
    }

    const cleaned = cleanupTranscript(transcript);

    return NextResponse.json({
      transcript: cleaned.oneLine,
      transcript_raw: cleaned.raw,
      reason: null,
      meta,
    });
  } catch (e: any) {
    return NextResponse.json(
      { transcript: null, reason: "BAD_REQUEST", error: String(e?.message || e) },
      { status: 400 }
    );
  }
}

// optional: GET for quick health check
export async function GET() {
  return NextResponse.json({ ok: true, hint: "POST { transcript } to clean" });
}
