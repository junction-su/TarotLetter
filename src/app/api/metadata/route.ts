export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextRequest, NextResponse } from "next/server";

export type MetadataFailReason =
  | "CONSENT_PAGE"
  | "AGE_RESTRICTED"
  | "PLAYER_RESPONSE_NOT_FOUND";

type MetadataResult =
  | {
      title: string | null;
      channelName: string | null;
      description: string | null;
      reason: null;
    }
  | {
      title: null;
      channelName: null;
      description: null;
      reason: MetadataFailReason;
    };

const HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9,ko;q=0.8",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",

  // IMPORTANT: 이 값이 PENDING이면 오히려 consent로 밀릴 수 있음
  Cookie: "CONSENT=YES+1; SOCS=CAI;",
};

function isConsent(html: string, finalUrl: string) {
  return (
    finalUrl.includes("consent.youtube.com") ||
    html.includes("consent.youtube.com") ||
    html.includes("Before you continue to YouTube") ||
    html.includes('action="https://consent.google.com')
  );
}

function isAgeGate(html: string) {
  return (
    html.includes("og:restrictions:age") ||
    html.includes('"reason":"Sign in to confirm your age"') ||
    html.includes("playerLegacyDesktopYpcOfferRenderer")
  );
}

function extractPlayerResponse(html: string): Record<string, any> | null {
  const m = html.match(
    /ytInitialPlayerResponse\s*=\s*(\{[\s\S]+?\});\s*<\/script/
  );
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  const videoId = req.nextUrl.searchParams.get("v");
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) {
    return NextResponse.json({ error: "Invalid video ID" }, { status: 400 });
  }

  try {
    for (const hl of ["ko", "en"]) {
      const url = `https://www.youtube.com/watch?v=${videoId}&hl=${hl}&persist_hl=1&bpctr=9999999999`;
      const res = await fetch(url, {
        headers: HEADERS,
        redirect: "follow",
        cache: "no-store",
      });

      if (!res.ok) continue;

      const finalUrl = res.url ?? url;
      const html = await res.text();
      console.log("[metadata] status", res.status, "finalUrl", res.url);
      console.log("[metadata] head", html.slice(0, 200));
      console.log("[metadata] hasYTIPR", html.includes("ytInitialPlayerResponse"));
      console.log("[metadata] hasPlayerResp", html.includes("playerResponse"));
      console.log("[metadata] hasConsent", html.includes("consent.youtube.com"));


      if (isConsent(html, finalUrl)) {
        if (hl === "ko") continue;
        return NextResponse.json<MetadataResult>({
          title: null,
          channelName: null,
          description: null,
          reason: "CONSENT_PAGE",
        });
      }

      if (isAgeGate(html)) {
        return NextResponse.json<MetadataResult>({
          title: null,
          channelName: null,
          description: null,
          reason: "AGE_RESTRICTED",
        });
      }

      const pr = extractPlayerResponse(html);
      if (!pr) {
        if (hl === "ko") continue;
        return NextResponse.json<MetadataResult>({
          title: null,
          channelName: null,
          description: null,
          reason: "PLAYER_RESPONSE_NOT_FOUND",
        });
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

    return NextResponse.json<MetadataResult>({
      title: null,
      channelName: null,
      description: null,
      reason: "PLAYER_RESPONSE_NOT_FOUND",
    });
  } catch {
    return NextResponse.json<MetadataResult>({
      title: null,
      channelName: null,
      description: null,
      reason: "PLAYER_RESPONSE_NOT_FOUND",
    });
  }
}
