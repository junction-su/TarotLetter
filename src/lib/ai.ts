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
 * Designed to produce structured note-style summaries that ONLY contain
 * statements explicitly present in the transcript — never generic tarot
 * phrases or invented meanings.
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
You do NOT use generic tarot phrases.
You only extract and reorganize what the reader actually said.

Your goal is to preserve as much specific content as possible while organizing it into clear sections.

The following text is from a tarot reading video.
The user selected: ${req.selectedCard}

CRITICAL RULES:
- ONLY include statements that explicitly appear in the input text.
- Do NOT shorten into vague themes.
- Do NOT use generic phrases like "trust your intuition", "transformation",
  "inner clarity", "balance", "new beginnings", or "alignment" unless the
  reader literally said those exact words.
- Keep concrete statements, situations, events, warnings, and predictions.
- Do NOT repeat the video title or card number.
- Do NOT create new interpretations or generalizations.
- If a statement was not said in the reading, do NOT include it.

Instructions:
1. Identify the main topics the reader talks about (for example: work, love, money, timing, personality, emotional state, specific situations, etc.).
2. Create section headings based on those actual topics.
3. Under each section, list bullet points capturing what the reader said — using their words, not paraphrasing into generic language.
4. If the reading mentions timeframes (days, weeks, months, seasons, "soon", "after a delay"), create a section called "Timing".
5. If there are warnings or cautions, create a section called "Things to Be Careful About".
6. If there are strong positive opportunities, create a section called "Opportunities".
7. Do not force sections that do not exist in the reading.
8. If the text is too short or vague to extract concrete statements, say so honestly rather than filling in generic content.

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
 *
 * IMPORTANT: The mock does NOT invent tarot content. If no transcript is
 * provided, it returns a placeholder directing the user to add their notes.
 */
export async function generateReadingSummary(
  req: SummaryRequest
): Promise<string> {
  // Simulate a brief delay for UX
  await new Promise((r) => setTimeout(r, 800));

  const useKorean =
    req.language === "ko" ||
    (req.language === "auto" && req.isKoreanContent);

  // If no transcript/notes provided, return a clear placeholder — never
  // fabricate content that wasn't in the reading.
  if (!req.transcript?.trim()) {
    if (useKorean) {
      return (
        `선택: ${req.selectedCard}\n\n` +
        `(정리할 내용이 없습니다. 위의 메모 입력란에 리딩 내용을 붙여넣으면 구조화된 요약이 생성됩니다.)`
      );
    }
    return (
      `Selection: ${req.selectedCard}\n\n` +
      `(No notes to organize. Paste what the reader said in the notes field above, then generate again to get a structured summary.)`
    );
  }

  // With a real AI provider this would call the API with buildPrompt(req).
  // For the MVP mock, echo back the user's own notes organized minimally —
  // never adding content that wasn't provided.
  if (useKorean) {
    return (
      `선택: ${req.selectedCard}\n\n` +
      `## 리딩 노트\n` +
      req.transcript
        .trim()
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => `- ${line.trim()}`)
        .join("\n")
    );
  }

  return (
    `Selection: ${req.selectedCard}\n\n` +
    `## Reading Notes\n` +
    req.transcript
      .trim()
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => `- ${line.trim()}`)
      .join("\n")
  );
}
