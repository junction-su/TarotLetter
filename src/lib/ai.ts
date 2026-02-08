/**
 * AI service abstraction layer.
 *
 * For the MVP this returns a placeholder summary.
 * Replace the implementation with an actual API call (e.g. OpenAI, Anthropic)
 * when a backend is available.
 */

export interface SummaryRequest {
  videoTitle: string;
  channelName: string;
  selectedCard: string;
}

export async function generateReadingSummary(
  req: SummaryRequest
): Promise<string> {
  // Simulate a brief delay for UX
  await new Promise((r) => setTimeout(r, 800));

  return (
    `Summary for ${req.selectedCard} from "${req.videoTitle}" by ${req.channelName}.\n\n` +
    `This reading focused on the energy surrounding ${req.selectedCard}. ` +
    `The reader discussed themes of transition, clarity, and alignment. ` +
    `Key messages included trusting your intuition and being open to unexpected changes. ` +
    `The overall tone was encouraging, emphasizing patience and self-trust.\n\n` +
    `[This is a placeholder summary. Connect an AI provider in src/lib/ai.ts to generate real summaries.]`
  );
}
