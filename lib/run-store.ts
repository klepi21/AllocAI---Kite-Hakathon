import { AgentDecision, TimelineEvent } from "@/lib/types";
import fs from "node:fs";
import path from "node:path";

export interface StoredPaidRun {
  runId: string;
  payerAddress: string | null;
  paymentReference: string;
  settlementReference: string;
  paymentTo: string;
  decision: AgentDecision;
  logs: TimelineEvent[];
  createdAt: string;
  runType?: "paid" | "autonomous";
  success?: boolean;
  responseTimeMs?: number;
}

type GlobalStore = typeof globalThis & {
  __allocaiPaidRuns?: StoredPaidRun[];
};

const STORE_FILE_PATH = path.join(process.cwd(), ".tmp", "allocai-runs.json");

function loadStoreFromDisk(): StoredPaidRun[] {
  try {
    if (!fs.existsSync(STORE_FILE_PATH)) return [];
    const raw = fs.readFileSync(STORE_FILE_PATH, "utf8");
    if (!raw.trim()) return [];
    const parsed = JSON.parse(raw) as StoredPaidRun[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistStoreToDisk(runs: StoredPaidRun[]): void {
  try {
    const dir = path.dirname(STORE_FILE_PATH);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STORE_FILE_PATH, JSON.stringify(runs), "utf8");
  } catch {
    // Best effort persistence; in-memory fallback remains active.
  }
}

function getStore(): StoredPaidRun[] {
  const g = globalThis as GlobalStore;
  if (!g.__allocaiPaidRuns) g.__allocaiPaidRuns = loadStoreFromDisk();
  return g.__allocaiPaidRuns;
}

export function savePaidRun(run: StoredPaidRun): void {
  const store = getStore();
  const next = [run, ...store.filter((item) => item.runId !== run.runId)];
  if (next.length > 300) next.length = 300;
  const g = globalThis as GlobalStore;
  g.__allocaiPaidRuns = next;
  persistStoreToDisk(next);
}

export function getRecentAutonomousRuns(limit: number): StoredPaidRun[] {
  const store = getStore();
  return store.filter((item) => item.runType === "autonomous").slice(0, limit);
}

export function getLatestAutonomousRun(): StoredPaidRun | null {
  const store = getStore();
  return store.find((item) => item.runType === "autonomous") || null;
}

export function getAllRuns(): StoredPaidRun[] {
  return getStore();
}

export function getLatestPaidRunByAddress(address: string): StoredPaidRun | null {
  const lower = address.toLowerCase();
  const store = getStore();
  return store.find((item) => item.payerAddress?.toLowerCase() === lower) || null;
}

export function getRecentPaidRunsByAddress(address: string, limit: number): StoredPaidRun[] {
  const lower = address.toLowerCase();
  const store = getStore();
  return store.filter((item) => item.payerAddress?.toLowerCase() === lower).slice(0, limit);
}

export function getPaidRunById(runId: string): StoredPaidRun | null {
  const store = getStore();
  return store.find((item) => item.runId === runId) || null;
}
