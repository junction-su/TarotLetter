/**
 * AI service abstraction layer.
 *
 * For the MVP this returns a deterministic summary.
 * Replace the implementation with an actual API call (e.g. OpenAI, Anthropic)
 * when a backend is available.
 */

export type SummaryLanguage = "auto" | "en" | "ko";

export interface SummaryRequest {
  videoTitle: string;
  channelName: string;
  selectedCard: string;
  language: SummaryLanguage;
  isKoreanContent?: boolean;
}

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
      `이 리딩은 ${req.selectedCard}에 해당하는 에너지에 초점을 맞추고 있습니다. ` +
      `리더는 전환, 명확성, 조화의 주제를 다루었습니다. ` +
      `핵심 메시지는 직관을 믿고 예상치 못한 변화에 열린 마음을 가지라는 것이었습니다. ` +
      `전체적인 톤은 격려적이며, 인내와 자기 신뢰를 강조했습니다.`
    );
  }

  return (
    `"${req.videoTitle}" — ${req.channelName}\n` +
    `Selection: ${req.selectedCard}\n\n` +
    `This reading focused on the energy surrounding ${req.selectedCard}. ` +
    `The reader discussed themes of transition, clarity, and alignment. ` +
    `Key messages included trusting your intuition and being open to unexpected changes. ` +
    `The overall tone was encouraging, emphasizing patience and self-trust.`
  );
}
