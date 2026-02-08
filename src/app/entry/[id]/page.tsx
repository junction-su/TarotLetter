"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { TarotEntry, OutcomeStatus } from "@/types/entry";
import { getEntry, saveEntry, deleteEntry } from "@/lib/storage";
import OutcomeBadge from "@/components/OutcomeBadge";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

const OUTCOME_OPTIONS: { value: OutcomeStatus; label: string }[] = [
  { value: "accurate", label: "Accurate" },
  { value: "mixed", label: "Mixed" },
  { value: "inaccurate", label: "Inaccurate" },
];

export default function EntryDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();

  const [entry, setEntry] = useState<TarotEntry | null>(null);
  const [outcomeStatus, setOutcomeStatus] = useState<OutcomeStatus>("none");
  const [outcomeNotes, setOutcomeNotes] = useState("");
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    const found = getEntry(params.id);
    if (found) {
      setEntry(found);
      setOutcomeStatus(found.outcomeStatus);
      setOutcomeNotes(found.outcomeNotes);
    }
  }, [params.id]);

  function handleSaveOutcome() {
    if (!entry) return;
    const updated: TarotEntry = {
      ...entry,
      outcomeStatus,
      outcomeNotes,
    };
    saveEntry(updated);
    setEntry(updated);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  function handleDelete() {
    if (!entry) return;
    if (window.confirm("Delete this reading? This cannot be undone.")) {
      deleteEntry(entry.id);
      router.push("/");
    }
  }

  if (!entry) {
    return (
      <div className="py-20 text-center text-mist/50">
        <p>Reading not found.</p>
        <a href="/" className="mt-2 inline-block text-sm text-violet-light underline">
          Back to timeline
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Back link */}
      <a href="/" className="text-sm text-lavender/50 hover:text-lavender">
        ← Back to timeline
      </a>

      {/* Header */}
      <div>
        <h1 className="mb-2 text-2xl leading-snug text-cream">
          {entry.videoTitle}
        </h1>
        <p className="text-sm text-lavender/60">{entry.channelName}</p>
      </div>

      {/* Meta */}
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="rounded bg-violet/20 px-3 py-1 text-violet-glow">
          {entry.selectedCard}
        </span>
        <OutcomeBadge status={entry.outcomeStatus} />
        <span className="text-mist/40">
          Saved {formatDate(entry.createdAt)}
        </span>
      </div>

      {/* YouTube link */}
      {entry.youtubeUrl && (
        <a
          href={entry.youtubeUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block text-sm text-violet-light underline hover:text-violet-glow"
        >
          Watch on YouTube →
        </a>
      )}

      {/* Transcript / Notes */}
      {entry.transcript && (
        <section>
          <h2 className="mb-3 text-sm font-medium uppercase tracking-widest text-lavender/50">
            What the Reader Said
          </h2>
          <div className="rounded-xl border border-twilight bg-dusk/40 p-5">
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-mist/80">
              {entry.transcript}
            </p>
          </div>
        </section>
      )}

      {/* AI Summary */}
      <section>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-widest text-lavender/50">
          Reading Summary
        </h2>
        <div className="rounded-xl border border-twilight bg-dusk/40 p-5">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-mist/80">
            {entry.aiSummary || "No summary recorded."}
          </p>
        </div>
      </section>

      {/* Revisit date */}
      <section>
        <h2 className="mb-2 text-sm font-medium uppercase tracking-widest text-lavender/50">
          Revisit Date
        </h2>
        <p className="text-sm text-cream">{formatDate(entry.revisitDate)}</p>
      </section>

      {/* Outcome Section */}
      <section className="rounded-xl border border-twilight bg-dusk/40 p-5">
        <h2 className="mb-4 text-sm font-medium uppercase tracking-widest text-gold">
          What actually happened?
        </h2>

        <div className="mb-4 flex flex-wrap gap-2">
          {OUTCOME_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setOutcomeStatus(opt.value)}
              className={`rounded-lg border px-4 py-2 text-sm transition-all ${
                outcomeStatus === opt.value
                  ? "border-violet bg-violet/20 text-violet-glow"
                  : "border-twilight text-lavender/60 hover:border-violet/40"
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>

        <textarea
          value={outcomeNotes}
          onChange={(e) => setOutcomeNotes(e.target.value)}
          rows={4}
          placeholder="Reflect on what happened…"
          className="mb-4 w-full rounded-lg border border-twilight bg-midnight px-4 py-3 text-sm leading-relaxed text-cream placeholder-mist/30 outline-none focus:border-violet"
        />

        <div className="flex items-center gap-3">
          <button
            onClick={handleSaveOutcome}
            className="rounded-lg bg-violet px-5 py-2.5 text-sm text-cream transition-colors hover:bg-violet-light"
          >
            Save Outcome
          </button>
          {saved && (
            <span className="text-sm text-sage">Saved</span>
          )}
        </div>
      </section>

      {/* Delete */}
      <div className="border-t border-twilight/30 pt-6">
        <button
          onClick={handleDelete}
          className="text-sm text-coral/60 hover:text-coral"
        >
          Delete this reading
        </button>
      </div>
    </div>
  );
}
