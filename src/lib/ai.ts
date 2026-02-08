/**
 * AI service abstraction layer.
 *
 * For the MVP this returns a deterministic mock summary.
 * When a real AI provider is connected, call it with `buildPrompt()`
 * to get structured reading notes.
 */

export type SummaryLanguage = "auto" | "en" | "ko";

export interface SummaryRequest {
  videoTitle: string;
  channelName: string;
  selectedCard: string;
  language: SummaryLanguage;
  isKoreanContent?: boolean;
  transcript?: string;
}

/**
 * System prompt for the AI provider.
 * Designed to produce structured note-style summaries, not vague themes.
 */
export function buildPrompt(req: SummaryRequest): string {
  const langInstruction =
    req.language === "ko" || (req.language === "auto" && req.isKoreanContent)
      ? "\nIMPORTANT: Write the entire output in Korean (한국어)."
      : "";

  return `You are an assistant that organizes tarot reading transcripts into structured notes.

You do NOT summarize loosely.
You do NOT invent meanings.
You do NOT add spiritual advice.
You only extract and reorganize what the reader actually said.

Your goal is to preserve as much specific content as possible while organizing it into clear sections.

The following text is from a tarot reading video.
The user selected: ${req.selectedCard}

IMPORTANT RULES:
- Do NOT shorten into vague themes.
- Keep concrete statements, situations, events, warnings, and predictions.
- Do NOT repeat the video title or card number.
- Do NOT create new interpretations.

Instructions:
1. Identify the main topics the reader talks about (for example: work, love, money, timing, personality, emotional state, specific situations, etc.).
2. Create section headings based on those actual topics.
3. Under each section, list bullet points capturing what the reader said.
4. If the reading mentions timeframes (days, weeks, months, seasons, "soon", "after a delay"), create a section called "Timing".
5. If there are warnings or cautions, create a section called "Things to Be Careful About".
6. If there are strong positive opportunities, create a section called "Opportunities".
7. Do not force sections that do not exist in the reading.

Write in a natural note-taking style, not like an essay.${langInstruction}

Text to analyze:
"""
{TRANSCRIPT_OR_NOTES}
"""`;
}

/**
 * Generate a reading summary.
 *
 * Currently returns a deterministic mock. To connect a real provider:
 *   1. Call buildPrompt(req) to get the system prompt
 *   2. Replace {TRANSCRIPT_OR_NOTES} with req.transcript
 *   3. Send to your AI API and return the response
 */
export async function generateReadingSummary(
  req: SummaryRequest
): Promise<string> {
  // Simulate a brief delay for UX
  await new Promise((r) => setTimeout(r, 800));

  const useKorean =
    req.language === "ko" ||
    (req.language === "auto" && req.isKoreanContent);

  if (useKorean) {
    return (
      `"${req.videoTitle}" — ${req.channelName}\n` +
      `선택: ${req.selectedCard}\n\n` +
      `## 전체적인 에너지\n` +
      `- 전환과 변화의 시기에 있음\n` +
      `- 내면의 명확성을 찾아가는 과정\n\n` +
      `## 핵심 메시지\n` +
      `- 직관을 믿을 것\n` +
      `- 예상치 못한 변화에 열린 마음을 가질 것\n` +
      `- 인내와 자기 신뢰가 중요\n\n` +
      `## 기회\n` +
      `- 새로운 방향으로의 전환이 긍정적인 결과를 가져올 수 있음\n` +
      `- 조화와 균형을 찾을 수 있는 시기`
    );
  }

  return (
    `"${req.videoTitle}" — ${req.channelName}\n` +
    `Selection: ${req.selectedCard}\n\n` +
    `## Overall Energy\n` +
    `- A period of transition and realignment\n` +
    `- Focus on gaining clarity about next steps\n\n` +
    `## Key Messages\n` +
    `- Trust your intuition over external opinions\n` +
    `- Be open to unexpected changes in direction\n` +
    `- Patience is emphasized — don't rush decisions\n\n` +
    `## Opportunities\n` +
    `- New doors opening in areas you weren't expecting\n` +
    `- A chance to reset and approach things differently`
  );
}
