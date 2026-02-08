import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

export type MetadataFailReason =
  | "CONSENT_PAGE"
  | "AGE_RESTRICTED"
  | "PLAYER_RESPONSE_NOT_FOUND";

type MetadataResult = {
  title: string | null;
  channelName: string | null;
  description: string | null;
  reason: MetadataFailReason | null;
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// ✅ transcript/metadata 둘 다 이 쿠키로 통일
const BASE_HEADERS: Record<string, string> = {
  "User-Agent": UA,
  "Accept-Language": "en-US,en;q=0.9,ko;q=0.8",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  Referer: "https://www.youtube.com/",
  // ✅ 중요한 건 CONSENT=YES / SOCS
  Cookie: "CONSENT=YES+1; SOCS=CAI;",
};

function fail(reason: MetadataFailReason) {
  return NextResponse.json<MetadataResult>({
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
    for (const hl of ["ko", "en"]) {
      const watchUrl =
        `https://www.youtube.com/watch?v=${videoId}` +
        `&hl=${hl}&gl=US&persist_hl=1&persist_gl=1&bpctr=9999999999&has_verified=1`;

      const res = await fetch(watchUrl, {
        headers: BASE_HEADERS,
        redirect: "follow",
        cache: "no-store",
      });

      if (!res.ok) continue;
      const html = await res.text();

      // ✅ consent 판단: "consent 도메인" + "playerResponse 없음" 조합으로만
      if (isConsentPage(html)) {
        if (hl === "ko") continue;
        return fail("CONSENT_PAGE");
      }

      if (isAgeRestricted(html)) return fail("AGE_RESTRICTED");

      const pr = extractInitialPlayerResponse(html);
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

      return NextResponse.json<MetadataResult>({
        title: videoDetails?.title ?? null,
        channelName:
          microformat?.playerMicroformatRenderer?.ownerChannelName ??
          videoDetails?.author ??
          null,
        description: videoDetails?.shortDescription ?? null,
        reason: null,
      });
    }

    return fail("PLAYER_RESPONSE_NOT_FOUND");
  } catch {
    return fail("PLAYER_RESPONSE_NOT_FOUND");
  }
}

function isConsentPage(html: string) {
  const hasConsentDomain =
    html.includes("consent.youtube.com") ||
    html.includes('action="https://consent.google.com') ||
    html.includes("CONSENT_PENDING");

  const hasPlayer = html.includes("ytInitialPlayerResponse");
  return hasConsentDomain && !hasPlayer;
}

function isAgeRestricted(html: string) {
  return (
    html.includes("og:restrictions:age") ||
    html.includes('"reason":"Sign in to confirm your age"') ||
    html.includes("playerLegacyDesktopYpcOfferRenderer")
  );
}

// ✅ 핵심: </script 같은 특정 형태에 의존하지 않음
function extractInitialPlayerResponse(html: string): Record<string, unknown> | null {
  const key = "ytInitialPlayerResponse";
  const idx = html.indexOf(key);
  if (idx === -1) return null;

  // "ytInitialPlayerResponse = { ... }" 패턴에서 첫 "{" 위치를 찾음
  const braceStart = html.indexOf("{", idx);
  if (braceStart === -1) return null;

  const jsonText = sliceBalancedBraces(html, braceStart);
  if (!jsonText) return null;

  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

function sliceBalancedBraces(s: string, start: number): string | null {
  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = start; i < s.length; i++) {
    const ch = s[i];

    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === "\\") {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    } else {
      if (ch === '"') {
        inStr = true;
        continue;
      }
      if (ch === "{") depth++;
      if (ch === "}") depth--;

      if (depth === 0) {
        return s.slice(start, i + 1);
      }
    }
  }
  return null;
}
