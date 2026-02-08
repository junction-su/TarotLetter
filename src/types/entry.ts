export type OutcomeStatus = "none" | "accurate" | "mixed" | "inaccurate";

export interface TarotEntry {
  id: string;
  youtubeUrl: string;
  videoTitle: string;
  channelName: string;
  createdAt: string; // ISO date string
  selectedCard: string;
  transcript: string; // raw notes or transcript from the reading
  aiSummary: string;
  revisitDate: string; // ISO date string
  outcomeStatus: OutcomeStatus;
  outcomeNotes: string;
}
