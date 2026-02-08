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
  Cookie:
    "SOCS=CAISNQgDEitib3FfaWRlbnRpdHlmcm9udGVuZHVpc2VydmVyXzIwMjQwNTI4LjA3X3AxGgJlbiACGgYIgMCxsgY; CONSENT=PENDING+987",
};

function fail(reason: MetadataFailReason): NextResponse<MetadataResult> {
  return NextResponse.json({
    title: null,
    channelName: null,
    description: null,
    reason,
  });
}

/**
 * GET /api/metadata?v=VIDEO_ID
 *
 * Lightweight route that fetches the YouTube watch page and extracts
 * title, channelName and description from ytInitialPlayerResponse.
 * Uses hardened browser-like headers with GDPR consent cookies.
 * Tries hl=ko first, then hl=en fallback.
 * Does NOT fetch captions — use /api/transcript for that.
 */
export async function GET(req: NextRequest) {
  const videoId = req.nextUrl.searchParams.get("v");
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) {
    return NextResponse.json({ error: "Invalid video ID" }, { status: 400 });
  }

  try {
    for (const hl of ["ko", "en"]) {
      const watchRes = await fetch(
        `https://www.youtube.com/watch?v=${videoId}&hl=${hl}&persist_hl=1&bpctr=9999999999`,
        { headers: BROWSER_HEADERS }
      );

      if (!watchRes.ok) continue;

      const html = await watchRes.text();

      // Detect consent / cookie-wall
      if (
        html.includes("consent.youtube.com") ||
        html.includes("accounts.google.com/ServiceLogin") ||
        html.includes('action="https://consent.google.com') ||
        html.includes("CONSENT_PENDING") ||
        (html.includes("<form") &&
          html.includes("consent") &&
          !html.includes("ytInitialPlayerResponse"))
      ) {
        // Try other hl before giving up
        if (hl === "ko") continue;
        return fail("CONSENT_PAGE");
      }

      // Detect age-restricted
      if (
        html.includes("og:restrictions:age") ||
        html.includes('"reason":"Sign in to confirm your age"') ||
        html.includes("playerLegacyDesktopYpcOfferRenderer")
      ) {
        return fail("AGE_RESTRICTED");
      }

      // Extract ytInitialPlayerResponse
      const prMatch = html.match(
        /ytInitialPlayerResponse\s*=\s*(\{[\s\S]+?\});\s*<\/script/
      );
      if (!prMatch) {
        if (hl === "ko") continue;
        return fail("PLAYER_RESPONSE_NOT_FOUND");
      }

      let playerResponse: Record<string, unknown>;
      try {
        playerResponse = JSON.parse(prMatch[1]);
      } catch {
        if (hl === "ko") continue;
        return fail("PLAYER_RESPONSE_NOT_FOUND");
      }

      const videoDetails = playerResponse?.videoDetails as
        | { title?: string; author?: string; shortDescription?: string }
        | undefined;

      const microformat = playerResponse?.microformat as
        | {
            playerMicroformatRenderer?: {
              ownerChannelName?: string;
            };
          }
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
