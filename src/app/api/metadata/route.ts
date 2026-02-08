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
 * Does NOT fetch captions — use /api/transcript for that.
 */
export async function GET(req: NextRequest) {
  const videoId = req.nextUrl.searchParams.get("v");
  if (!videoId || !/^[\w-]{11}$/.test(videoId)) {
    return NextResponse.json({ error: "Invalid video ID" }, { status: 400 });
  }

  try {
    const watchRes = await fetch(
      `https://www.youtube.com/watch?v=${videoId}&hl=en`,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept-Language": "en-US,en;q=0.9",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
      }
    );

    if (!watchRes.ok) {
      return fail("PLAYER_RESPONSE_NOT_FOUND");
    }

    const html = await watchRes.text();

    // Detect consent / cookie-wall
    if (
      html.includes("consent.youtube.com") ||
      html.includes("accounts.google.com/ServiceLogin") ||
      html.includes('action="https://consent.google.com')
    ) {
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
      /ytInitialPlayerResponse\s*=\s*(\{.+?\});\s*<\/script/s
    );
    if (!prMatch) {
      return fail("PLAYER_RESPONSE_NOT_FOUND");
    }

    let playerResponse: Record<string, unknown>;
    try {
      playerResponse = JSON.parse(prMatch[1]);
    } catch {
      return fail("PLAYER_RESPONSE_NOT_FOUND");
    }

    const videoDetails = playerResponse?.videoDetails as
      | { title?: string; author?: string; shortDescription?: string }
      | undefined;

    // Also try microformat for channel name (more reliable)
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
  } catch {
    return fail("PLAYER_RESPONSE_NOT_FOUND");
  }
}
