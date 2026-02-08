import { TarotEntry } from "@/types/entry";

const STORAGE_KEY = "tarotletter_entries";

function isClient(): boolean {
  return typeof window !== "undefined";
}

export function getAllEntries(): TarotEntry[] {
  if (!isClient()) return [];
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as TarotEntry[];
  } catch {
    return [];
  }
}

export function getEntry(id: string): TarotEntry | undefined {
  return getAllEntries().find((e) => e.id === id);
}

export function saveEntry(entry: TarotEntry): void {
  const entries = getAllEntries();
  const index = entries.findIndex((e) => e.id === entry.id);
  if (index >= 0) {
    entries[index] = entry;
  } else {
    entries.push(entry);
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

export function deleteEntry(id: string): void {
  const entries = getAllEntries().filter((e) => e.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
