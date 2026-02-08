"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TarotEntry } from "@/types/entry";
import { saveEntry, generateId } from "@/lib/storage";
import {
  fetchVideoMeta,
  parseTimecodes,
  containsKorean,
  type VideoMeta,
  type TimecodeOption,
} from "@/lib/youtube";
import { generateReadingSummary, type SummaryLanguage } from "@/lib/ai";

const FALLBACK_CARDS = ["Card 1", "Card 2", "Card 3", "Card 4"];

const REVISIT_CHIPS: { label: string; weeks: number }[] = [
  { label: "+1 week", weeks: 1 },
  { label: "+2 weeks", weeks: 2 },
  { label: "+4 weeks", weeks: 4 },
  { label: "+8 weeks", weeks: 8 },
];

function addWeeks(weeks: number): string {
  const d = new Date();
  d.setDate(d.getDate() + weeks * 7);
  return d.toISOString().split("T")[0];
}

function formatChipDate(weeks: number): string {
  const d = new Date();
  d.setDate(d.getDate() + weeks * 7);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function NewEntryPage() {
  const router = useRouter();

  // Step 1: URL
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState(false);
  const [videoMeta, setVideoMeta] = useState<VideoMeta | null>(null);

  // Timecodes extracted from title (oEmbed doesn't give description)
  const [timecodeOptions, setTimecodeOptions] = useState<TimecodeOption[]>([]);
  const [isKorean, setIsKorean] = useState(false);

  // Step 2+: Form
  const [selectedCard, setSelectedCard] = useState("");
  const [customCard, setCustomCard] = useState("");
  const [revisitDate, setRevisitDate] = useState("");
  const [activeChip, setActiveChip] = useState<number | null>(null);
  const [showCustomDate, setShowCustomDate] = useState(false);

  // Transcript / notes
  const [transcript, setTranscript] = useState("");

  // Summary
  const [summaryLang, setSummaryLang] = useState<SummaryLanguage>("auto");
  const [aiSummary, setAiSummary] = useState("");
  const [generating, setGenerating] = useState(false);
  const [summaryGenerated, setSummaryGenerated] = useState(false);

  const [saving, setSaving] = useState(false);

  const effectiveCard = selectedCard === "Custom" ? customCard : selectedCard;
  const fetched = videoMeta !== null;

  async function handleFetch() {
    if (!youtubeUrl.trim()) return;
    setFetching(true);
    setFetchError(false);

    const meta = await fetchVideoMeta(youtubeUrl);
    if (meta) {
      setVideoMeta(meta);
      // Parse timecodes from title (best we can do without API key)
      const tc = parseTimecodes(meta.title);
      setTimecodeOptions(tc);
      // Detect Korean
      setIsKorean(containsKorean(meta.title));
    } else {
      setFetchError(true);
    }
    setFetching(false);
  }

  function handleChipSelect(weeks: number) {
    setActiveChip(weeks);
    setRevisitDate(addWeeks(weeks));
    setShowCustomDate(false);
  }

  function handleCustomDateToggle() {
    setActiveChip(null);
    setShowCustomDate(true);
  }

  async function handleGenerateSummary() {
    if (!videoMeta || !effectiveCard) return;
    setGenerating(true);
    const summary = await generateReadingSummary({
      videoTitle: videoMeta.title,
      channelName: videoMeta.channelName,
      selectedCard: effectiveCard,
      language: summaryLang,
      isKoreanContent: isKorean,
      transcript: transcript,
    });
    setAiSummary(summary);
    setSummaryGenerated(true);
    setGenerating(false);
  }

  async function handleSave() {
    if (!videoMeta || !effectiveCard || !revisitDate) return;
    setSaving(true);

    const entry: TarotEntry = {
      id: generateId(),
      youtubeUrl,
      videoTitle: videoMeta.title,
      channelName: videoMeta.channelName,
      createdAt: new Date().toISOString(),
      selectedCard: effectiveCard,
      transcript,
      aiSummary,
      revisitDate,
      outcomeStatus: "none",
      outcomeNotes: "",
    };

    saveEntry(entry);
    router.push("/");
  }

  const canGenerate = fetched && effectiveCard;
  const canSave = fetched && effectiveCard && revisitDate;

  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold text-cream">New Reading</h1>

      {/* ── Step 1: YouTube URL ── */}
      <section className="space-y-3">
        <label className="block text-sm text-mist/60">YouTube URL</label>
        <div className="flex gap-2">
          <input
            type="url"
            value={youtubeUrl}
            onChange={(e) => {
              setYoutubeUrl(e.target.value);
              if (fetchError) setFetchError(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleFetch();
            }}
            placeholder="Paste a YouTube link…"
            className="flex-1 rounded-lg border border-twilight bg-dusk px-4 py-3 text-sm text-cream placeholder-mist/30 outline-none transition-colors focus:border-violet/60"
          />
          <button
            onClick={handleFetch}
            disabled={!youtubeUrl.trim() || fetching}
            className="rounded-lg bg-violet px-5 py-3 text-sm font-medium text-cream transition-colors hover:bg-violet-light disabled:opacity-40"
          >
            {fetching ? "Loading…" : "Continue"}
          </button>
        </div>
        {fetchError && (
          <p className="text-sm text-coral">
            Could not fetch video info. Check the URL and try again.
          </p>
        )}
      </section>

      {/* ── Step 2: Video Card ── */}
      {fetched && (
        <section className="flex gap-4 rounded-xl border border-twilight/60 bg-dusk p-4">
          {videoMeta.thumbnailUrl && (
            <img
              src={videoMeta.thumbnailUrl}
              alt=""
              className="h-20 w-36 flex-shrink-0 rounded-lg object-cover"
            />
          )}
          <div className="flex flex-col justify-center gap-1 overflow-hidden">
            <p className="truncate text-sm font-medium text-cream">
              {videoMeta.title}
            </p>
            <p className="truncate text-xs text-mist/50">
              {videoMeta.channelName}
            </p>
          </div>
        </section>
      )}

      {/* ── Step 3: Card Selection ── */}
      {fetched && (
        <section className="space-y-3">
          <label className="block text-sm text-mist/60">
            Which card did you choose?
          </label>

          {/* Timecode-based options (if found) */}
          {timecodeOptions.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs text-mist/40">From video</p>
              <div className="flex flex-wrap gap-2">
                {timecodeOptions.map((tc) => (
                  <button
                    key={tc.time}
                    onClick={() => setSelectedCard(tc.label)}
                    className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                      selectedCard === tc.label
                        ? "border-violet bg-violet/20 text-violet-glow"
                        : "border-twilight/60 text-mist/60 hover:border-violet/40 hover:text-mist/80"
                    }`}
                  >
                    {tc.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Fallback options */}
          <div className="flex flex-wrap gap-2">
            {FALLBACK_CARDS.map((card) => (
              <button
                key={card}
                onClick={() => setSelectedCard(card)}
                className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                  selectedCard === card
                    ? "border-violet bg-violet/20 text-violet-glow"
                    : "border-twilight/60 text-mist/60 hover:border-violet/40 hover:text-mist/80"
                }`}
              >
                {card}
              </button>
            ))}
            <button
              onClick={() => setSelectedCard("Custom")}
              className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                selectedCard === "Custom"
                  ? "border-violet bg-violet/20 text-violet-glow"
                  : "border-twilight/60 text-mist/60 hover:border-violet/40 hover:text-mist/80"
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
              className="w-full rounded-lg border border-twilight bg-dusk px-4 py-2.5 text-sm text-cream placeholder-mist/30 outline-none transition-colors focus:border-violet/60"
            />
          )}
        </section>
      )}

      {/* ── Step 4: Revisit Date ── */}
      {fetched && (
        <section className="space-y-3">
          <label className="block text-sm text-mist/60">
            When should you revisit this?
          </label>
          <div className="flex flex-wrap gap-2">
            {REVISIT_CHIPS.map((chip) => (
              <button
                key={chip.weeks}
                onClick={() => handleChipSelect(chip.weeks)}
                className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                  activeChip === chip.weeks
                    ? "border-violet bg-violet/20 text-violet-glow"
                    : "border-twilight/60 text-mist/60 hover:border-violet/40 hover:text-mist/80"
                }`}
              >
                {chip.label}
                <span className="ml-1.5 text-xs text-mist/30">
                  {formatChipDate(chip.weeks)}
                </span>
              </button>
            ))}
            <button
              onClick={handleCustomDateToggle}
              className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                showCustomDate
                  ? "border-violet bg-violet/20 text-violet-glow"
                  : "border-twilight/60 text-mist/60 hover:border-violet/40 hover:text-mist/80"
              }`}
            >
              Custom date
            </button>
          </div>
          {showCustomDate && (
            <input
              type="date"
              value={revisitDate}
              onChange={(e) => {
                setRevisitDate(e.target.value);
                setActiveChip(null);
              }}
              min={new Date().toISOString().split("T")[0]}
              className="rounded-lg border border-twilight bg-dusk px-4 py-2.5 text-sm text-cream outline-none transition-colors focus:border-violet/60"
            />
          )}
        </section>
      )}

      {/* ── Step 5: Transcript / Notes ── */}
      {fetched && (
        <section className="space-y-3">
          <label className="block text-sm text-mist/60">
            What did the reader say?
          </label>
          <p className="text-xs text-mist/40">
            Paste the transcript or type your notes from the reading. Only what
            you write here will appear in the summary — nothing is invented.
          </p>
          <textarea
            value={transcript}
            onChange={(e) => setTranscript(e.target.value)}
            rows={6}
            placeholder="e.g., The reader said there's a job offer coming in March, possibly from someone you already know. They warned about signing contracts too quickly…"
            className="w-full rounded-lg border border-twilight bg-dusk px-4 py-3 text-sm leading-relaxed text-cream placeholder-mist/30 outline-none transition-colors focus:border-violet/60"
          />
        </section>
      )}

      {/* ── Step 6: Summary ── */}
      {fetched && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <label className="text-sm text-mist/60">Reading Summary</label>
            <div className="flex items-center gap-2">
              <select
                value={summaryLang}
                onChange={(e) =>
                  setSummaryLang(e.target.value as SummaryLanguage)
                }
                className="rounded-md border border-twilight bg-dusk px-2 py-1 text-xs text-mist/60 outline-none"
              >
                <option value="auto">Auto</option>
                <option value="en">English</option>
                <option value="ko">한국어</option>
              </select>
              <button
                onClick={handleGenerateSummary}
                disabled={!canGenerate || generating}
                className="rounded-lg bg-violet px-4 py-2 text-sm font-medium text-cream transition-colors hover:bg-violet-light disabled:opacity-40"
              >
                {generating ? "Generating…" : "Generate Summary"}
              </button>
            </div>
          </div>

          {summaryGenerated && (
            <textarea
              value={aiSummary}
              onChange={(e) => setAiSummary(e.target.value)}
              rows={6}
              className="w-full rounded-lg border border-twilight bg-dusk px-4 py-3 text-sm leading-relaxed text-cream outline-none transition-colors focus:border-violet/60"
            />
          )}
        </section>
      )}

      {/* ── Save ── */}
      {fetched && (
        <button
          onClick={handleSave}
          disabled={!canSave || saving}
          className="w-full rounded-lg bg-violet py-3 text-center text-sm font-medium text-cream transition-colors hover:bg-violet-light disabled:opacity-40"
        >
          {saving ? "Saving…" : "Save Reading"}
        </button>
      )}
    </div>
  );
}
