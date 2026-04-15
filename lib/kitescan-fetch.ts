import { ethers } from "ethers";

export interface KitescanTx {
  hash?: string;
  from?: string | { hash?: string } | null;
  to?: string | { hash?: string } | null;
  value?: string | null;
  result?: string | null;
  status?: string | null;
  raw_input?: string | null;
}

export function kitescanAddressLower(value: string | KitescanTx["from"]): string {
  if (!value) return "";
  if (typeof value === "string") return ethers.isAddress(value) ? value.toLowerCase() : "";
  if (typeof value === "object" && value && "hash" in value && typeof value.hash === "string" && ethers.isAddress(value.hash)) {
    return value.hash.toLowerCase();
  }
  return "";
}

export function txSucceeded(tx: KitescanTx): boolean {
  const r = (tx.result || tx.status || "").toLowerCase();
  return !r || r === "success" || r === "ok";
}

export function decodeAllocaiSummaryRunId(rawInput: string | null | undefined): string | null {
  if (!rawInput || !rawInput.startsWith("0x") || rawInput === "0x") return null;
  try {
    const decoded = ethers.toUtf8String(rawInput as `0x${string}`);
    if (!decoded.startsWith("ALLOCAI_SUMMARY|")) return null;
    const parts = decoded.split("|");
    return parts[1] || null;
  } catch {
    return null;
  }
}

export async function fetchKitescanAddressTransactions(address: string, limit: number): Promise<KitescanTx[]> {
  const apiBase = (process.env.KITESCAN_API_BASE_URL || "https://kitescan.ai/api/v2").replace(/\/+$/, "");
  const apiKey = process.env.KITESCAN_API_KEY || "";
  const query = new URL(`${apiBase}/addresses/${address}/transactions`);
  query.searchParams.set("limit", String(Math.min(Math.max(limit, 1), 100)));
  if (apiKey) query.searchParams.set("apikey", apiKey);

  const response = await fetch(query.toString(), {
    headers: {
      Accept: "application/json",
      ...(apiKey ? { "x-api-key": apiKey } : {})
    },
    cache: "no-store"
  }).catch(() => null);

  if (!response?.ok) return [];
  const payload = (await response.json().catch(() => null)) as { items?: KitescanTx[] } | null;
  return Array.isArray(payload?.items) ? payload!.items : [];
}

export function getServiceWalletAddress(): string | null {
  const pk = process.env.SERVICE_WALLET_PRIVATE_KEY || process.env.AGENT_PRIVATE_KEY;
  if (!pk) return null;
  try {
    return new ethers.Wallet(pk).address;
  } catch {
    return null;
  }
}
