"use client";

import { useEffect, useState } from "react";
import { TarotEntry } from "@/types/entry";
import { getAllEntries } from "@/lib/storage";
import EntryCard from "@/components/EntryCard";

export default function HomePage() {
  const [entries, setEntries] = useState<TarotEntry[]>([]);

  useEffect(() => {
    setEntries(getAllEntries());
  }, []);

  const today = new Date().toISOString().split("T")[0];

  const toRevisit = entries.filter(
    (e) => e.revisitDate <= today && e.outcomeStatus === "none"
  );

  const sorted = [...entries].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );

  return (
    <div className="space-y-10">
      {/* Readings to Revisit */}
      {toRevisit.length > 0 && (
        <section>
          <h2 className="mb-4 text-sm font-medium uppercase tracking-widest text-gold">
            Readings to Revisit
          </h2>
          <div className="space-y-3">
            {toRevisit.map((entry) => (
              <EntryCard key={entry.id} entry={entry} />
            ))}
          </div>
        </section>
      )}

      {/* All Readings */}
      <section>
        <h2 className="mb-4 text-sm font-medium uppercase tracking-widest text-lavender/60">
          All Readings
        </h2>
        {sorted.length === 0 ? (
          <div className="rounded-xl border border-dashed border-twilight py-16 text-center">
            <p className="mb-1 text-lg text-lavender/80">No readings yet</p>
            <p className="text-sm text-mist/50">
              Start by adding your first tarot reading.
            </p>
            <a
              href="/new"
              className="mt-4 inline-block rounded-lg bg-violet px-5 py-2 text-sm text-cream transition-colors hover:bg-violet-light"
            >
              + New Reading
            </a>
          </div>
        ) : (
          <div className="space-y-3">
            {sorted.map((entry) => (
              <EntryCard key={entry.id} entry={entry} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
