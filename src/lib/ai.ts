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

CRITICAL RULES:
- Every bullet point must be directly grounded in the input text. If you cannot point to where it was said, do not include it.
- ONLY include statements that explicitly appear in the input text.
- Do NOT shorten into vague themes.
- Do NOT use generic phrases like "trust your intuition", "transformation",
  "inner clarity", "balance", "new beginnings", or "alignment" unless the
  reader literally said those exact words.
- Keep concrete statements, situations, events, warnings, and predictions.
- Do NOT repeat the video title, channel name, or selected card label in the output.
- Do NOT create new interpretations or generalizations.
- If a statement was not said in the reading, do NOT include it.

Instructions:
1. Read the entire text and identify the actual topics the reader discusses.
2. Create section headings dynamically based on those topics — do not use a fixed template.
3. Under each section, list bullet points capturing what the reader said — using their words, not paraphrasing into generic language.
4. Only create a section if the reading contains concrete statements for it.
5. If the text is too short or vague to extract concrete statements, say so honestly rather than filling in generic content.

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
    (req.language === "auto" && req.isKoreanContent === true);

  // If no transcript/notes provided, return a short instruction — never
  // fabricate content that wasn't in the reading.
  if (!req.transcript?.trim()) {
    return useKorean
      ? "(리딩 내용을 위의 메모란에 붙여넣은 후 다시 생성해 주세요.)"
      : "(Paste what the reader said in the notes field above, then generate again.)";
  }

  // With a real AI provider this would call the API with buildPrompt(req).
  // For the MVP mock, do a simple structural extraction: group lines into
  // topic-based sections using keyword detection, preserving only what the
  // user actually typed — never adding content.
  return structureTranscript(req.transcript, useKorean);
}

// ── Simple keyword-based grouping for MVP (no LLM) ──

const TOPIC_PATTERNS: { key: string; en: string; ko: string; re: RegExp }[] = [
  { key: "work", en: "Work / Career", ko: "직장 / 커리어", re: /\b(job|work|career|boss|company|promotion|office|business|interview|hire|fired|resign|colleague)\b/i },
  { key: "love", en: "Love / Relationships", ko: "연애 / 관계", re: /\b(love|relationship|partner|ex|dating|marriage|boyfriend|girlfriend|crush|breakup|romantic|spouse)\b/i },
  { key: "money", en: "Money / Finances", ko: "돈 / 재정", re: /\b(money|financ|salary|debt|invest|pay|income|expense|saving|afford|budget|wealth)\b/i },
  { key: "timing", en: "Timing", ko: "시기", re: /\b(january|february|march|april|may|june|july|august|september|october|november|december|week|month|year|soon|spring|summer|fall|autumn|winter|days?\b|next\s)/i },
  { key: "warning", en: "Things to Be Careful About", ko: "주의할 점", re: /\b(careful|warning|caution|avoid|watch out|don'?t|beware|risk|danger|toxic|negative)\b/i },
  { key: "health", en: "Health", ko: "건강", re: /\b(health|sick|doctor|hospital|stress|anxiety|sleep|energy|tired|body|mental)\b/i },
];

function structureTranscript(transcript: string, korean: boolean): string {
  const lines = transcript
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length === 0) return "";

  // Assign each line to the first matching topic, or "general"
  const buckets = new Map<string, string[]>();

  for (const line of lines) {
    let assigned = false;
    for (const topic of TOPIC_PATTERNS) {
      if (topic.re.test(line)) {
        if (!buckets.has(topic.key)) buckets.set(topic.key, []);
        buckets.get(topic.key)!.push(line);
        assigned = true;
        break;
      }
    }
    if (!assigned) {
      if (!buckets.has("general")) buckets.set("general", []);
      buckets.get("general")!.push(line);
    }
  }

  // Build output with dynamic headings — only sections that have content
  const sections: string[] = [];

  for (const topic of TOPIC_PATTERNS) {
    const bucket = buckets.get(topic.key);
    if (!bucket) continue;
    const heading = korean ? topic.ko : topic.en;
    sections.push(
      `## ${heading}\n` + bucket.map((l) => `- ${l}`).join("\n")
    );
  }

  // General bucket last (only if there were also topic-specific buckets)
  const general = buckets.get("general");
  if (general) {
    if (sections.length > 0) {
      const heading = korean ? "기타" : "Other";
      sections.push(
        `## ${heading}\n` + general.map((l) => `- ${l}`).join("\n")
      );
    } else {
      // Everything fell into general — no headings needed, just bullets
      sections.push(general.map((l) => `- ${l}`).join("\n"));
    }
  }

  return sections.join("\n\n");
}
