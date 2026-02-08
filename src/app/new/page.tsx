"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TarotEntry } from "@/types/entry";
import { saveEntry, generateId } from "@/lib/storage";
import { fetchVideoMeta } from "@/lib/youtube";
import { generateReadingSummary } from "@/lib/ai";

const CARD_OPTIONS = ["Card 1", "Card 2", "Card 3", "Card 4"];

export default function NewEntryPage() {
  const router = useRouter();

  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [videoTitle, setVideoTitle] = useState("");
  const [channelName, setChannelName] = useState("");
  const [fetchStatus, setFetchStatus] = useState<
    "idle" | "loading" | "done" | "error"
  >("idle");

  const [selectedCard, setSelectedCard] = useState("");
  const [customCard, setCustomCard] = useState("");
  const [revisitDate, setRevisitDate] = useState("");

  const [aiSummary, setAiSummary] = useState("");
  const [generating, setGenerating] = useState(false);

  const [saving, setSaving] = useState(false);

  const effectiveCard = selectedCard === "Custom" ? customCard : selectedCard;

  async function handleFetchMeta() {
    setFetchStatus("loading");
    const meta = await fetchVideoMeta(youtubeUrl);
    if (meta) {
      setVideoTitle(meta.title);
      setChannelName(meta.channelName);
      setFetchStatus("done");
    } else {
      setFetchStatus("error");
    }
  }

  async function handleGenerateSummary() {
    if (!videoTitle || !effectiveCard) return;
    setGenerating(true);
    const summary = await generateReadingSummary({
      videoTitle,
      channelName,
      selectedCard: effectiveCard,
    });
    setAiSummary(summary);
    setGenerating(false);
  }

  async function handleSave() {
    if (!videoTitle || !effectiveCard || !revisitDate) return;
    setSaving(true);

    const entry: TarotEntry = {
      id: generateId(),
      youtubeUrl,
      videoTitle,
      channelName,
      createdAt: new Date().toISOString(),
      selectedCard: effectiveCard,
      aiSummary,
      revisitDate,
      outcomeStatus: "none",
      outcomeNotes: "",
    };

    saveEntry(entry);
    router.push("/");
  }

  const canGenerate = videoTitle && effectiveCard;
  const canSave = videoTitle && effectiveCard && revisitDate;

  return (
    <div className="space-y-8">
      <h1 className="text-2xl text-lavender">New Reading</h1>

      {/* YouTube URL */}
      <section className="space-y-3">
        <label className="block text-sm text-mist/70">YouTube URL</label>
        <div className="flex gap-2">
          <input
            type="url"
            value={youtubeUrl}
            onChange={(e) => {
              setYoutubeUrl(e.target.value);
              setFetchStatus("idle");
            }}
            placeholder="https://www.youtube.com/watch?v=..."
            className="flex-1 rounded-lg border border-twilight bg-midnight px-4 py-2.5 text-sm text-cream placeholder-mist/30 outline-none focus:border-violet"
          />
          <button
            onClick={handleFetchMeta}
            disabled={!youtubeUrl || fetchStatus === "loading"}
            className="rounded-lg bg-twilight px-4 py-2.5 text-sm text-lavender transition-colors hover:bg-violet/30 disabled:opacity-40"
          >
            {fetchStatus === "loading" ? "Fetching…" : "Fetch"}
          </button>
        </div>
        {fetchStatus === "done" && (
          <div className="rounded-lg border border-violet/20 bg-violet/5 p-3">
            <p className="text-sm font-medium text-cream">{videoTitle}</p>
            <p className="text-xs text-lavender/60">{channelName}</p>
          </div>
        )}
        {fetchStatus === "error" && (
          <p className="text-sm text-coral">
            Could not fetch video info. You can enter details manually below.
          </p>
        )}
        {(fetchStatus === "error" || fetchStatus === "idle") && (
          <div className="space-y-2">
            <input
              type="text"
              value={videoTitle}
              onChange={(e) => setVideoTitle(e.target.value)}
              placeholder="Video title (manual entry)"
              className="w-full rounded-lg border border-twilight bg-midnight px-4 py-2 text-sm text-cream placeholder-mist/30 outline-none focus:border-violet"
            />
            <input
              type="text"
              value={channelName}
              onChange={(e) => setChannelName(e.target.value)}
              placeholder="Channel name (manual entry)"
              className="w-full rounded-lg border border-twilight bg-midnight px-4 py-2 text-sm text-cream placeholder-mist/30 outline-none focus:border-violet"
            />
          </div>
        )}
      </section>

      {/* Card Selection */}
      <section className="space-y-3">
        <label className="block text-sm text-mist/70">Card Selection</label>
        <div className="flex flex-wrap gap-2">
          {CARD_OPTIONS.map((card) => (
            <button
              key={card}
              onClick={() => setSelectedCard(card)}
              className={`rounded-lg border px-4 py-2 text-sm transition-all ${
                selectedCard === card
                  ? "border-violet bg-violet/20 text-violet-glow"
                  : "border-twilight text-lavender/60 hover:border-violet/40"
              }`}
            >
              {card}
            </button>
          ))}
          <button
            onClick={() => setSelectedCard("Custom")}
            className={`rounded-lg border px-4 py-2 text-sm transition-all ${
              selectedCard === "Custom"
                ? "border-violet bg-violet/20 text-violet-glow"
                : "border-twilight text-lavender/60 hover:border-violet/40"
            }`}
          >
            Custom
          </button>
        </div>
        {selectedCard === "Custom" && (
          <input
            type="text"
            value={customCard}
            onChange={(e) => setCustomCard(e.target.value)}
            placeholder="e.g., Pile 2 — The Tower"
            className="w-full rounded-lg border border-twilight bg-midnight px-4 py-2 text-sm text-cream placeholder-mist/30 outline-none focus:border-violet"
          />
        )}
      </section>

      {/* Revisit Date */}
      <section className="space-y-3">
        <label className="block text-sm text-mist/70">Revisit Date</label>
        <input
          type="date"
          value={revisitDate}
          onChange={(e) => setRevisitDate(e.target.value)}
          min={new Date().toISOString().split("T")[0]}
          className="rounded-lg border border-twilight bg-midnight px-4 py-2.5 text-sm text-cream outline-none focus:border-violet"
        />
      </section>

      {/* AI Summary */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <label className="text-sm text-mist/70">Reading Summary</label>
          <button
            onClick={handleGenerateSummary}
            disabled={!canGenerate || generating}
            className="rounded-lg bg-violet px-4 py-2 text-sm text-cream transition-colors hover:bg-violet-light disabled:opacity-40"
          >
            {generating ? "Generating…" : "Generate Summary"}
          </button>
        </div>
        <textarea
          value={aiSummary}
          onChange={(e) => setAiSummary(e.target.value)}
          rows={6}
          placeholder="AI-generated summary will appear here. You can also write your own."
          className="w-full rounded-lg border border-twilight bg-midnight px-4 py-3 text-sm leading-relaxed text-cream placeholder-mist/30 outline-none focus:border-violet"
        />
      </section>

      {/* Save */}
      <button
        onClick={handleSave}
        disabled={!canSave || saving}
        className="w-full rounded-lg bg-violet py-3 text-center text-sm font-medium text-cream transition-colors hover:bg-violet-light disabled:opacity-40"
      >
        {saving ? "Saving…" : "Save Reading"}
      </button>
    </div>
  );
}
