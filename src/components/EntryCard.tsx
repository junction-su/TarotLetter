"use client";

import { TarotEntry } from "@/types/entry";
import OutcomeBadge from "./OutcomeBadge";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

export default function EntryCard({ entry }: { entry: TarotEntry }) {
  const summaryPreview =
    entry.aiSummary.length > 120
      ? entry.aiSummary.slice(0, 120) + "…"
      : entry.aiSummary;

  return (
    <a
      href={`/entry/${entry.id}`}
      className="block rounded-xl border border-twilight bg-dusk/60 p-5 transition-all hover:border-violet/40 hover:bg-dusk"
    >
      <div className="mb-2 flex items-start justify-between gap-3">
        <h3 className="text-base font-medium leading-snug text-cream">
          {entry.videoTitle}
        </h3>
        <OutcomeBadge status={entry.outcomeStatus} />
      </div>

      <div className="mb-3 flex items-center gap-3 text-xs text-lavender/70">
        <span className="rounded bg-violet/20 px-2 py-0.5 text-violet-glow">
          {entry.selectedCard}
        </span>
        <span>Revisit {formatDate(entry.revisitDate)}</span>
      </div>

      <p className="text-sm leading-relaxed text-mist/70">{summaryPreview}</p>
    </a>
  );
}
