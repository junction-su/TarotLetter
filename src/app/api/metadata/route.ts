// src/app/api/metadata/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";

export type MetadataFailReason =
  | "CONSENT_PAGE"
  | "AGE_RESTRICTED"
  | "PLAYER_RESPONSE_NOT_FOUND";

interface MetadataResult {
  title: string | null;
  channelName: string | null;
  description: string | null;
  reason: MetadataFailReason | null;
}

const BROWSER_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9,ko;q=0.8",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Sec-Ch-Ua":
    '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "Sec-Ch-Ua-Mobile": "?0",
  "Sec-Ch-Ua-Platform": '"Windows"',
  Referer: "https://www.youtube.com/",
  // 서버에서 이 쿠키로 뚫리는 환경도 있고, 안 되는 환경도 있음.
  // PENDING은 오히려 차단 트리거가 되기도 해서 빼는 편이 낫다.
  Cookie: "CONSENT=YES+1; SOCS=CAI;",
};

function fail(reason: MetadataFailReason): NextResponse<MetadataResult> {
  return NextResponse.json({
    title: null,
    channelName: null,
    description: null,
    reason,
  });
}

export async function GET(req: NextRequest) {
  const videoId = req.nextUrl.searchParams.get("v");
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) {
    return NextResponse.json({ error: "Invalid video ID" }, { status: 400 });
  }

  try {
    for (const hl of ["ko", "en"] as const) {
      const watchUrl =
        `https://www.youtube.com/watch?v=${videoId}` +
        `&hl=${hl}&persist_hl=1&bpctr=9999999999&has_verified=1`;

      const watchRes = await fetch(watchUrl, {
        headers: BROWSER_HEADERS,
        cache: "no-store",
      });

      if (!watchRes.ok) continue;

      const html = await watchRes.text();

      const blocked = detectBlockedPage(html);
      if (blocked) {
        console.log("[api/metadata] BLOCKED:", blocked, "hl=", hl);
        console.log("[api/metadata] BLOCKED HTML HEAD:", html.slice(0, 300));
        if (hl === "ko") continue;
        return fail(blocked);
      }

      const pr = extractPlayerResponse(html);
      if (!pr) {
        if (hl === "ko") continue;
        return fail("PLAYER_RESPONSE_NOT_FOUND");
      }

      const videoDetails = pr.videoDetails as
        | { title?: string; author?: string; shortDescription?: string }
        | undefined;

      const microformat = pr.microformat as
        | { playerMicroformatRenderer?: { ownerChannelName?: string } }
        | undefined;

      const title = videoDetails?.title ?? null;
      const channelName =
        microformat?.playerMicroformatRenderer?.ownerChannelName ??
        videoDetails?.author ??
        null;

      const description = videoDetails?.shortDescription ?? null;

      return NextResponse.json<MetadataResult>({
        title,
        channelName,
        description,
        reason: null,
      });
    }

    return fail("PLAYER_RESPONSE_NOT_FOUND");
  } catch {
    return fail("PLAYER_RESPONSE_NOT_FOUND");
  }
}

function detectBlockedPage(html: string): MetadataFailReason | null {
  if (
    html.includes("consent.youtube.com") ||
    html.includes("accounts.google.com/ServiceLogin") ||
    html.includes('action="https://consent.google.com') ||
    html.includes("CONSENT_PENDING") ||
    (html.includes("<form") &&
      html.toLowerCase().includes("consent") &&
      !html.includes("ytInitialPlayerResponse"))
  ) {
    return "CONSENT_PAGE";
  }

  if (
    html.includes("og:restrictions:age") ||
    html.includes('"reason":"Sign in to confirm your age"') ||
    html.includes("playerLegacyDesktopYpcOfferRenderer")
  ) {
    return "AGE_RESTRICTED";
  }

  return null;
}

function extractPlayerResponse(html: string): Record<string, unknown> | null {
  const m = html.match(
    /ytInitialPlayerResponse\s*=\s*(\{[\s\S]+?\});\s*<\/script/,
  );
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}
