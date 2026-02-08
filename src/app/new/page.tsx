"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { TarotEntry } from "@/types/entry";
import { saveEntry, generateId } from "@/lib/storage";
import {
  fetchMetadata,
  fetchVideoMeta,
  fetchTranscript,
  extractVideoId,
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

  // Timecodes extracted from title + description
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
  const [transcriptStatus, setTranscriptStatus] = useState<
    "idle" | "loading" | "auto" | "manual"
  >("idle");
  const [transcriptFailReason, setTranscriptFailReason] = useState<
    string | null
  >(null);
  const [showCopyHelp, setShowCopyHelp] = useState(false);

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
    setTranscriptStatus("idle");
    setSelectedCard("");

    // ── 1. Fetch metadata (title, channel, description) from watch page ──
    const md = await fetchMetadata(youtubeUrl);

    let title: string;
    let channelName: string;
    let description: string | null = null;

    if (md.title && md.channelName) {
      title = md.title;
      channelName = md.channelName;
      description = md.description;
    } else {
      // Fallback to oEmbed (no description available)
      const oEmbed = await fetchVideoMeta(youtubeUrl);
      if (!oEmbed) {
        setFetchError(true);
        setFetching(false);
        return;
      }
      title = oEmbed.title;
      channelName = oEmbed.channelName;
    }

    const videoId = extractVideoId(youtubeUrl);
    const thumbnailUrl = videoId
      ? `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`
      : null;

    setVideoMeta({ title, channelName, thumbnailUrl });

    // ── 2. Parse timestamps from description (primary) or title (fallback) ──
    const descTc = description ? parseTimecodes(description) : [];
    const titleTc = parseTimecodes(title);
    setTimecodeOptions(descTc.length > 0 ? descTc : titleTc);

    // Korean detection from title + description
    setIsKorean(
      containsKorean(title) ||
        (description ? containsKorean(description) : false)
    );

    // ── 3. Fetch transcript ──
    setTranscriptStatus("loading");
    setTranscriptFailReason(null);
    const result = await fetchTranscript(youtubeUrl);

    if (result.transcript) {
      setTranscript(result.transcript);
      setTranscriptStatus("auto");
    } else {
      setTranscriptFailReason(result.reason);
      setTranscriptStatus("manual");
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

  const canGenerate = fetched && effectiveCard && transcript.trim().length > 0;
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

          {/* Timecode-based options from video description / title */}
          {timecodeOptions.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs text-mist/40">From video</p>
              <div className="flex flex-wrap gap-2">
                {timecodeOptions.map((tc) => (
                  <button
                    key={tc.startSeconds}
                    onClick={() => setSelectedCard(tc.label)}
                    className={`rounded-lg border px-3 py-2 text-sm transition-colors ${
                      selectedCard === tc.label
                        ? "border-violet bg-violet/20 text-violet-glow"
                        : "border-twilight/60 text-mist/60 hover:border-violet/40 hover:text-mist/80"
                    }`}
                  >
                    {tc.label}
                    <span className="ml-1.5 text-xs text-mist/30">
                      {tc.time}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Fallback Card 1-4 only when no timestamps were found */}
          {timecodeOptions.length === 0 && (
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
            </div>
          )}

          {/* Custom option — always available */}
          <div className="flex flex-wrap gap-2">
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

          {/* Status indicator */}
          {transcriptStatus === "loading" && (
            <p className="text-xs text-lavender/60">
              Fetching transcript from YouTube…
            </p>
          )}
          {transcriptStatus === "auto" && (
            <p className="text-xs text-sage">
              Transcript imported automatically. Review and edit if needed.
            </p>
          )}
          {transcriptStatus === "manual" && (
            <div className="space-y-1">
              <p className="text-xs text-gold/80">
                {transcriptFailReason === "CONSENT_PAGE"
                  ? "YouTube returned a consent/cookie page. The transcript couldn\u2019t be fetched automatically."
                  : transcriptFailReason === "AGE_RESTRICTED"
                    ? "This video is age-restricted. YouTube requires a login to access its transcript."
                    : transcriptFailReason === "NO_CAPTIONS"
                      ? "This video has no captions available on YouTube."
                      : transcriptFailReason === "PLAYER_RESPONSE_NOT_FOUND"
                        ? "Couldn\u2019t read the video page. The video may be private or unavailable."
                        : transcriptFailReason === "ASR_NOT_CONFIGURED"
                          ? "No captions found and automatic speech recognition is not configured."
                          : "Transcript not available for this video."}{" "}
                Paste it manually below.
              </p>
              <button
                type="button"
                onClick={() => setShowCopyHelp((v) => !v)}
                className="text-xs text-violet-light underline hover:text-violet-glow"
              >
                {showCopyHelp
                  ? "Hide instructions"
                  : "How do I copy a YouTube transcript?"}
              </button>
              {showCopyHelp && (
                <ol className="ml-4 list-decimal space-y-1 text-xs leading-relaxed text-mist/50">
                  <li>
                    Open the video on YouTube in a desktop browser.
                  </li>
                  <li>
                    Click the <strong className="text-mist/70">…</strong> (more)
                    button below the video.
                  </li>
                  <li>
                    Select{" "}
                    <strong className="text-mist/70">Show transcript</strong>.
                  </li>
                  <li>
                    A transcript panel opens on the right. Click inside it, press{" "}
                    <kbd className="rounded border border-twilight px-1 text-mist/70">
                      Ctrl+A
                    </kbd>{" "}
                    (or{" "}
                    <kbd className="rounded border border-twilight px-1 text-mist/70">
                      Cmd+A
                    </kbd>
                    ) to select all, then{" "}
                    <kbd className="rounded border border-twilight px-1 text-mist/70">
                      Ctrl+C
                    </kbd>{" "}
                    to copy.
                  </li>
                  <li>Paste it into the field below.</li>
                </ol>
              )}
            </div>
          )}

          {/* Always show the textarea once status is resolved */}
          {transcriptStatus !== "idle" && transcriptStatus !== "loading" && (
            <>
              <textarea
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
                rows={8}
                placeholder="Paste the transcript or type your notes from the reading…"
                className="w-full rounded-lg border border-twilight bg-dusk px-4 py-3 text-sm leading-relaxed text-cream placeholder-mist/30 outline-none transition-colors focus:border-violet/60"
              />
              <p className="text-xs text-mist/40">
                Only what appears here will be used in the summary — nothing is
                invented.
              </p>
            </>
          )}
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
