"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { ethers } from "ethers";
import { toast } from "sonner";
import Header from "@/components/Header";
import WalletPanel from "@/components/WalletPanel";
import YieldTable from "@/components/YieldTable";
import DecisionPanel from "@/components/DecisionPanel";
import Timeline from "@/components/Timeline";
import { EtheralShadow } from "@/components/ui/etheral-shadow";
import { useKiteWallet } from "@/hooks/useKiteWallet";
import { AgentDecision, TimelineEvent, YieldOpportunity } from "@/lib/types";

const QuickSwap = dynamic(() => import("@/components/QuickSwap"), {
  ssr: false,
  loading: () => <div className="glass-card rounded-[2rem] border-white/5 bg-[#151515] p-6 h-full" />
});

const LucidBridge = dynamic(() => import("@/components/LucidBridge"), {
  ssr: false,
  loading: () => <div className="glass-card rounded-[2rem] border-white/5 bg-[#151515] p-6 h-full" />
});

type ProofRecord = {
  id: string;
  txHash: string;
  timestamp: string;
  action: string;
  protocol: string;
  confidence: number;
  reason: string;
};

type ChainBalance = {
  chain: string;
  balance: number | null;
  status: "ok" | "unavailable";
};

type LatestRunMeta = {
  runId: string;
  createdAt: string;
  paymentReference: string;
  settlementReference: string;
  paymentConfirmed: boolean;
  proofConfirmed: boolean;
  paymentTxHash: string | null;
  proofTxHash: string | null;
  paymentBlockNumber: number | null;
  proofBlockNumber: number | null;
  paymentExplorerUrl: string | null;
  proofExplorerUrl: string | null;
};

type KpiSnapshot = {
  totalRuns: number;
  paidRuns: number;
  autonomousRuns: number;
  proofsPosted: number;
  avgResponseMs: number;
  successRate: number;
  kpiSource?: "store" | "explorer" | "merged" | "none";
};

type AutonomousStatus = {
  enabled: boolean;
  intervalHours: number;
  testPortfolioUsdc: number;
  profileLabel: string;
  baselineApr: number;
  requiresServerAuth: boolean;
  nextRunAt: string;
  latest: {
    runId: string;
    createdAt: string;
    decision?: AgentDecision;
    responseTimeMs?: number | null;
    success?: boolean;
  } | null;
};

function formatCountdown(targetIso: string | null, nowMs: number): string {
  if (!targetIso) return "Calculating...";
  const targetMs = new Date(targetIso).getTime();
  if (!Number.isFinite(targetMs)) return "Calculating...";
  const diffMs = targetMs - nowMs;
  if (diffMs <= 0) return "Ready now";
  const totalSec = Math.floor(diffMs / 1000);
  const hours = Math.floor(totalSec / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

type X402ChallengeResponse = {
  error?: string;
  accepts?: Array<{
    resource?: string;
    network?: string;
    maxAmountRequired?: string;
    asset?: string;
    payTo?: string;
  }>;
};

type PaymentRequirement = {
  payTo: string;
  asset: string;
  maxAmountRequired: string;
  network: string;
};

type PassportMcpClient = {
  callTool: (toolName: string, args: Record<string, unknown>) => Promise<unknown>;
};

type PassportWindow = Window & {
  mcpClient?: PassportMcpClient;
  kiteMcpClient?: PassportMcpClient;
  kitePassport?: {
    getXPaymentToken?: (input: { challenge: X402ChallengeResponse }) => Promise<string>;
    approvePayment?: (input: { challenge: X402ChallengeResponse }) => Promise<string>;
  };
  kitePassportProvider?: {
    getXPaymentToken?: (input: { challenge: X402ChallengeResponse }) => Promise<string>;
    approvePayment?: (input: { challenge: X402ChallengeResponse }) => Promise<string>;
  };
};

function getStringField(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const candidate = record[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

async function acquireXPaymentTokenAutomatically(challenge: X402ChallengeResponse): Promise<string | null> {
  if (typeof window === "undefined") return null;

  const cached = window.localStorage.getItem("x402_payment_token");
  if (cached) return cached;

  const w = window as PassportWindow;
  const providerCandidates = [w.kitePassport, w.kitePassportProvider];
  for (const provider of providerCandidates) {
    if (!provider) continue;
    if (provider.getXPaymentToken) {
      try {
        const token = await provider.getXPaymentToken({ challenge });
        if (token) {
          window.localStorage.setItem("x402_payment_token", token);
          return token;
        }
      } catch {
        // Try MCP fallback if direct provider method fails.
      }
    }
    if (provider.approvePayment) {
      try {
        const token = await provider.approvePayment({ challenge });
        if (token) {
          window.localStorage.setItem("x402_payment_token", token);
          return token;
        }
      } catch {
        // Try MCP fallback if direct provider method fails.
      }
    }
  }

  const mcpClient = w.kiteMcpClient || w.mcpClient;
  if (!mcpClient) return null;
  try {
    const payerRaw = await mcpClient.callTool("get_payer_addr", {});
    const payerAddr =
      getStringField(payerRaw, "payer_addr") ||
      getStringField(payerRaw, "payerAddr") ||
      getStringField(payerRaw, "address");
    const paymentRequest = challenge.accepts?.[0];
    if (!payerAddr || !paymentRequest?.payTo || !paymentRequest.maxAmountRequired) return null;
    const approvalRaw = await mcpClient.callTool("approve_payment", {
      payer_addr: payerAddr,
      payee_addr: paymentRequest.payTo,
      amount: paymentRequest.maxAmountRequired,
      token_type: "USDC",
      merchant_name: "AllocAI"
    });
    const token =
      getStringField(approvalRaw, "x_payment") ||
      getStringField(approvalRaw, "xPayment") ||
      getStringField(approvalRaw, "token");
    if (!token) return null;
    window.localStorage.setItem("x402_payment_token", token);
    return token;
  } catch {
    return null;
  }
}

const CHAIN_LOGOS: Record<string, string> = {
  Kite: "https://icons.llama.fi/ethereum.png",
  Arbitrum: "https://arbitrum.io/_next/image?url=%2Fbrandkit%2F1225_Arbitrum_Logomark_OneColorNavy_ClearSpace.png&w=640&q=75",
  Avalanche: "https://icons.llama.fi/avalanche.png",
  Optimism: "https://icons.llama.fi/optimism.jpg",
  Base: "https://images.cryptorank.io/coins/base1682407673437.png",
  BSC: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1c/BNB%2C_native_cryptocurrency_for_the_Binance_Smart_Chain.svg/330px-BNB%2C_native_cryptocurrency_for_the_Binance_Smart_Chain.svg.png",
  Celo: "https://static.vecteezy.com/system/resources/previews/024/092/749/non_2x/celo-glass-crypto-coin-3d-illustration-free-png.png"
};

const USDC_LOGO = "https://icons.llama.fi/usd-coin.jpg";
const FIXED_AGENT_FEE_KITE = "0.25";
const DIRECT_KITE_FEE_WEI = ethers.parseEther(FIXED_AGENT_FEE_KITE);
const PREMIUM_UNLOCK_WINDOW_MS = 10 * 60 * 1000;
const KITE_EXPLORER_BASE =
  process.env.NEXT_PUBLIC_KITE_NETWORK?.toLowerCase() === "testnet" ||
  process.env.NEXT_PUBLIC_KITE_RPC?.toLowerCase().includes("testnet")
    ? "https://testnet.kitescan.ai"
    : "https://kitescan.ai";
export default function Home() {
  const { address, signer } = useKiteWallet();
  const [opportunities, setOpportunities] = useState<YieldOpportunity[]>([]);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<"idle" | "scanning" | "thinking" | "logging" | "purchasing">("idle");
  const [activeActionTab, setActiveActionTab] = useState<"swap" | "bridge">("bridge");
  const [decision, setDecision] = useState<AgentDecision | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [proofs, setProofs] = useState<ProofRecord[]>([]);
  const [paidStakeAmount, setPaidStakeAmount] = useState("");
  const [paidRisk, setPaidRisk] = useState<"low" | "medium">("low");
  const [paymentMode, setPaymentMode] = useState<"direct" | "x402">("direct");
  const [showAgentModal, setShowAgentModal] = useState(false);
  const [premiumUnlocked, setPremiumUnlocked] = useState(false);
  const [chainBalances, setChainBalances] = useState<ChainBalance[]>([]);
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [paidRunError, setPaidRunError] = useState("");
  const decisionSectionRef = useRef<HTMLDivElement | null>(null);
  const [paymentRequirement, setPaymentRequirement] = useState<PaymentRequirement | null>(null);
  const [paymentBalanceLoading, setPaymentBalanceLoading] = useState(false);
  const [nativeKiteBalanceWei, setNativeKiteBalanceWei] = useState<bigint | null>(null);
  const [x402TokenBalanceWei, setX402TokenBalanceWei] = useState<bigint | null>(null);
  const [lastPaidRunAt, setLastPaidRunAt] = useState<string | null>(null);
  const [latestRuns, setLatestRuns] = useState<LatestRunMeta[]>([]);
  const [inModalLoadingStep, setInModalLoadingStep] = useState(0);
  const [kpis, setKpis] = useState<KpiSnapshot | null>(null);
  const [autonomousStatus, setAutonomousStatus] = useState<AutonomousStatus | null>(null);
  const [countdownNowMs, setCountdownNowMs] = useState(Date.now());
  const [bridgePrefill, setBridgePrefill] = useState<{ chain: string; amount?: string } | null>(null);
  const [enteredApp, setEnteredApp] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined" && window.location.search.includes("strategyRun")) {
      setEnteredApp(true);
    }
  }, []);

  const topApr = useMemo(() => {
    if (!opportunities.length) return 0;
    return Math.max(...opportunities.map((o) => o.apr));
  }, [opportunities]);
  const topTvl = useMemo(() => {
    if (!opportunities.length) return 0;
    return Math.max(...opportunities.map((o) => o.liquidity));
  }, [opportunities]);

  const addEvent = (message: string, type: TimelineEvent["type"]) => {
    setEvents((prev) => [{ id: Math.random().toString(36).slice(2), timestamp: new Date().toISOString(), message, type }, ...prev].slice(0, 20));
  };

  const scrollToDecisionSection = () => {
    decisionSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const fetchOpportunities = useCallback(async () => {
    setLoading(true);
    try {
      const qs = address ? `?address=${encodeURIComponent(address)}` : "";
      const response = await fetch(`/api/yield${qs}`, { cache: "no-store", credentials: "include" });
      const data = await response.json();
      const rows: YieldOpportunity[] = Array.isArray(data?.opportunities) ? data.opportunities : [];
      setOpportunities(rows);
      if (typeof data?.yieldTableUnlocked === "boolean") {
        setPremiumUnlocked(data.yieldTableUnlocked);
      }
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    void fetchOpportunities();
  }, [fetchOpportunities]);

  useEffect(() => {
    const loadKpis = async () => {
      try {
        const response = await fetch("/api/kpi", { cache: "no-store" });
        if (!response.ok) return;
        const payload = (await response.json()) as KpiSnapshot;
        setKpis(payload);
      } catch {
        // Keep existing KPI snapshot on transient errors.
      }
    };
    loadKpis();
    const interval = setInterval(loadKpis, 30_000);
    return () => clearInterval(interval);
  }, []);

  const loadAutonomousStatus = useCallback(async () => {
    try {
      const response = await fetch("/api/autonomous/status", { cache: "no-store" });
      if (!response.ok) return;
      const payload = (await response.json()) as AutonomousStatus;
      setAutonomousStatus(payload);
    } catch {
      // Keep existing autonomous state on transient errors.
    }
  }, []);

  useEffect(() => {
    const interval = setInterval(() => setCountdownNowMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const refreshStatus = async () => {
      await loadAutonomousStatus();
    };
    refreshStatus();
    const interval = setInterval(() => {
      refreshStatus();
    }, 60_000);
    return () => clearInterval(interval);
  }, [loadAutonomousStatus]);

  useEffect(() => {
    if (!address) return;
    let active = true;
    const hydrateLatestByAddress = async () => {
      try {
        const response = await fetch(`/api/strategy/latest?address=${address}`, { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as {
          runs?: LatestRunMeta[];
          latest?: {
            decision?: AgentDecision;
            logs?: TimelineEvent[];
            createdAt?: string;
          };
        };
        if (!active || !data.latest?.decision) return;
        setDecision(data.latest.decision);
        if (Array.isArray(data.latest.logs)) setEvents(data.latest.logs);
        setLastPaidRunAt(data.latest.createdAt || null);
        setLatestRuns(Array.isArray(data.runs) ? data.runs : []);
        if (data.latest.decision.proofReceipt?.txHash) {
          setProofs([
            {
              id: data.latest.decision.proofReceipt.runId,
              txHash: data.latest.decision.proofReceipt.txHash,
              timestamp: data.latest.decision.proofReceipt.timestamp,
              action: data.latest.decision.action.toUpperCase(),
              protocol: data.latest.decision.selectedOpportunity?.protocol || "N/A",
              confidence: data.latest.decision.confidence,
              reason: data.latest.decision.reason
            }
          ]);
        }
        if (data.latest.createdAt) {
          const isFresh = Date.now() - new Date(data.latest.createdAt).getTime() <= PREMIUM_UNLOCK_WINDOW_MS;
          setPremiumUnlocked(isFresh);
        } else {
          setPremiumUnlocked(false);
        }
      } catch {
        // No latest strategy found for this wallet.
      }
    };
    hydrateLatestByAddress();
    return () => {
      active = false;
    };
  }, [address]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const runId = new URLSearchParams(window.location.search).get("strategyRun");
    if (!runId) return;
    let active = true;
    const hydrateByRunId = async () => {
      try {
        const response = await fetch(`/api/strategy/latest?runId=${runId}`, { cache: "no-store" });
        if (!response.ok) return;
        const data = (await response.json()) as {
          decision?: AgentDecision;
          logs?: TimelineEvent[];
          createdAt?: string;
          runId?: string;
          paymentReference?: string;
          settlementReference?: string;
          paymentConfirmed?: boolean;
          proofConfirmed?: boolean;
          paymentTxHash?: string | null;
          proofTxHash?: string | null;
          paymentBlockNumber?: number | null;
          proofBlockNumber?: number | null;
          paymentExplorerUrl?: string | null;
          proofExplorerUrl?: string | null;
        };
        if (!active || !data.decision) return;
        setDecision(data.decision);
        if (Array.isArray(data.logs)) setEvents(data.logs);
        setLastPaidRunAt(data.createdAt || null);
        if (
          typeof data.runId === "string" &&
          typeof data.createdAt === "string" &&
          typeof data.paymentReference === "string" &&
          typeof data.settlementReference === "string"
        ) {
          setLatestRuns([{
            runId: data.runId,
            createdAt: data.createdAt,
            paymentReference: data.paymentReference,
            settlementReference: data.settlementReference,
            paymentConfirmed: Boolean(data.paymentConfirmed),
            proofConfirmed: Boolean(data.proofConfirmed),
            paymentTxHash: data.paymentTxHash ?? null,
            proofTxHash: data.proofTxHash ?? null,
            paymentBlockNumber: data.paymentBlockNumber ?? null,
            proofBlockNumber: data.proofBlockNumber ?? null,
            paymentExplorerUrl: data.paymentExplorerUrl ?? null,
            proofExplorerUrl: data.proofExplorerUrl ?? null
          }]);
        }
        if (data.createdAt) {
          const isFresh = Date.now() - new Date(data.createdAt).getTime() <= PREMIUM_UNLOCK_WINDOW_MS;
          setPremiumUnlocked(isFresh);
        } else {
          setPremiumUnlocked(false);
        }
      } catch {
        // Ignore invalid run id.
      }
    };
    hydrateByRunId();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!lastPaidRunAt) {
      setPremiumUnlocked(false);
      return;
    }
    const updateUnlockState = () => {
      const isFresh = Date.now() - new Date(lastPaidRunAt).getTime() <= PREMIUM_UNLOCK_WINDOW_MS;
      setPremiumUnlocked(isFresh);
      if (!isFresh) void fetchOpportunities();
    };
    updateUnlockState();
    const interval = setInterval(updateUnlockState, 30_000);
    return () => clearInterval(interval);
  }, [lastPaidRunAt, fetchOpportunities]);

  useEffect(() => {
    if (decision) scrollToDecisionSection();
  }, [decision]);

  useEffect(() => {
    if (!showAgentModal) return;
    let active = true;
    const loadPaymentRequirement = async () => {
      try {
        const response = await fetch("/api/paid-data", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({})
        });
        if (response.status !== 402) return;
        const challenge = (await response.json().catch(() => ({}))) as X402ChallengeResponse;
        const accepted = challenge.accepts?.[0];
        if (!active || !accepted?.payTo || !accepted.asset || !accepted.maxAmountRequired || !accepted.network) return;
        setPaymentRequirement({
          payTo: accepted.payTo,
          asset: accepted.asset,
          maxAmountRequired: accepted.maxAmountRequired,
          network: accepted.network
        });
      } catch {
        if (active) setPaymentRequirement(null);
      }
    };
    loadPaymentRequirement();
    return () => {
      active = false;
    };
  }, [showAgentModal]);

  useEffect(() => {
    if (!showAgentModal || !address || !signer || !paymentRequirement) return;
    let active = true;
    const loadPreflightBalances = async () => {
      setPaymentBalanceLoading(true);
      try {
        const provider = signer.provider;
        if (!provider) throw new Error("Missing signer provider");
        const [nativeResult, tokenResult] = await Promise.allSettled([
          provider.getBalance(address),
          new ethers.Contract(
            paymentRequirement.asset,
            ["function balanceOf(address account) view returns (uint256)"],
            provider
          ).balanceOf(address) as Promise<bigint>
        ]);
        if (!active) return;
        setNativeKiteBalanceWei(nativeResult.status === "fulfilled" ? nativeResult.value : null);
        setX402TokenBalanceWei(tokenResult.status === "fulfilled" ? tokenResult.value : null);
      } catch {
        if (!active) return;
        setNativeKiteBalanceWei(null);
        setX402TokenBalanceWei(null);
      } finally {
        if (active) setPaymentBalanceLoading(false);
      }
    };
    loadPreflightBalances();
    return () => {
      active = false;
    };
  }, [showAgentModal, address, signer, paymentRequirement]);

  const requiredX402TokenUnits = paymentRequirement ? BigInt(paymentRequirement.maxAmountRequired) : 0n;
  const requiredByModeUnits = paymentMode === "direct" ? DIRECT_KITE_FEE_WEI : requiredX402TokenUnits;
  const activeBalanceWei = paymentMode === "direct" ? nativeKiteBalanceWei : x402TokenBalanceWei;
  const hasSufficientBalance = activeBalanceWei !== null && activeBalanceWei >= requiredByModeUnits;
  const parsedStakeAmount = Number(paidStakeAmount);
  const hasValidStakeAmount = Number.isFinite(parsedStakeAmount) && parsedStakeAmount > 0;
  const readyForPayment =
    Boolean(address && signer && paymentRequirement) &&
    hasValidStakeAmount &&
    !paymentBalanceLoading &&
    hasSufficientBalance;

  useEffect(() => {
    const loadBalances = async () => {
      if (!address) {
        setChainBalances([]);
        return;
      }
      setBalancesLoading(true);
      try {
        const response = await fetch(`/api/usdc-balances?address=${address}`, { cache: "no-store" });
        const data = await response.json();
        const rows: ChainBalance[] = Array.isArray(data?.balances) ? data.balances : [];
        setChainBalances(rows);
      } finally {
        setBalancesLoading(false);
      }
    };

    loadBalances();
    const interval = setInterval(loadBalances, 45000);
    return () => clearInterval(interval);
  }, [address]);

  const logDecision = async (payload: {
    action: string;
    protocol: string;
    confidence: number;
    reason: string;
  }) => {
    const onChainResponse = await fetch("/api/on-chain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const onChainResult = await onChainResponse.json();
    if (!onChainResult?.success) return null;
    const record: ProofRecord = {
      id: Math.random().toString(36).slice(2),
      txHash: onChainResult.txHash,
      timestamp: new Date().toISOString(),
      action: payload.action || "HOLD",
      protocol: payload.protocol || "N/A",
      confidence: payload.confidence || 0,
      reason: payload.reason || "Logged by agent"
    };
    setProofs((prev) => [record, ...prev].slice(0, 20));
    return record;
  };

  const runAgent = async (paidDataUsed: boolean, customTvl: number) => {
    if (!opportunities.length) return;
    setStatus("scanning");
    addEvent("Scanning USDC opportunities across Lucid-reachable routes.", "scan");
    await fetchOpportunities();

    setStatus("thinking");
    addEvent("Computing best route using APR, TVL, and risk model.", "decision");
    const decisionResponse = await fetch("/api/decision", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        currentApr: topApr,
        paidDataUsed,
        opportunities,
        tvl: customTvl
      })
    });
    const decisionData: AgentDecision = await decisionResponse.json();
    setDecision(decisionData);

    setStatus("logging");
    addEvent("Logging recommendation proof on-chain.", "on-chain");
    await logDecision({
      action: decisionData.action.toUpperCase(),
      protocol: decisionData.selectedOpportunity?.protocol || "HOLD",
      confidence: decisionData.confidence,
      reason: decisionData.reason
    });
    setStatus("idle");
  };

  const handleRunAgent = async () => {
    await runAgent(false, topTvl);
  };

  const handlePaidRun = async () => {
    setStatus("purchasing");
    setPaidRunError("");
    setInModalLoadingStep(0);
    scrollToDecisionSection();
    addEvent(`Starting paid strategy run (fee: ${FIXED_AGENT_FEE_KITE} KITE).`, "purchase");
    const strategyToast = toast.loading("Processing paid agent run...");
    try {
      if (!hasValidStakeAmount) {
        throw new Error("Enter a valid portfolio amount in USDC before running the paid agent.");
      }
      const safeTvl = parsedStakeAmount;
      const safeAmount = parsedStakeAmount;
      const body = JSON.stringify({
        amountKite: FIXED_AGENT_FEE_KITE,
        amountUsdc: safeAmount,
        currentApr: topApr,
        opportunities,
        tvl: safeTvl,
        risk: paidRisk
      });

      const initialResponse = await fetch("/api/paid-data", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body
      });

      let finalResponse = initialResponse;
      if (initialResponse.status === 402) {
        const challenge = (await initialResponse.json().catch(() => ({}))) as X402ChallengeResponse;
        if (paymentMode === "direct") {
          if (!signer || !address) throw new Error("Connect wallet first for direct KITE payment.");
          const paymentRequest = challenge.accepts?.[0];
          if (!paymentRequest?.payTo) {
            throw new Error("Payment configuration missing from server challenge.");
          }
          addEvent(`Submitting direct KITE payment to ${paymentRequest.payTo.slice(0, 10)}...`, "payment");
          setInModalLoadingStep(1);
          const paymentToast = toast.loading(`Waiting wallet confirmation for ${FIXED_AGENT_FEE_KITE} KITE payment...`);
          const paymentTx = await signer.sendTransaction({
            to: paymentRequest.payTo,
            value: DIRECT_KITE_FEE_WEI
          });
          toast.dismiss(paymentToast);
          const paymentMiningToast = toast.loading(`Payment submitted: ${paymentTx.hash.slice(0, 12)}...`);
          setInModalLoadingStep(2);
          await paymentTx.wait();
          toast.dismiss(paymentMiningToast);
          toast.success(`Payment confirmed: ${paymentTx.hash.slice(0, 12)}...`);
          addEvent(`Direct payment confirmed (${paymentTx.hash.slice(0, 12)}...)`, "payment");
          finalResponse = await fetch("/api/paid-data", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-DIRECT-PAYMENT-TX": paymentTx.hash
            },
            credentials: "include",
            body: JSON.stringify({
              ...JSON.parse(body),
              payerAddress: address
            })
          });
        } else {
          addEvent("Payment required. Requesting X-PAYMENT token from Kite Passport.", "payment");
          setInModalLoadingStep(1);
          const autoToken = await acquireXPaymentTokenAutomatically(challenge);
          const manualToken =
            autoToken ||
            (typeof window !== "undefined"
              ? window.prompt(
                  `Automatic Passport token failed. Paste X-PAYMENT token for ${challenge.accepts?.[0]?.network || "kite-mainnet"}`
                ) || ""
              : "");
          if (!manualToken) throw new Error("Missing X-PAYMENT token. Connect Passport session or paste a valid token.");
          if (typeof window !== "undefined") window.localStorage.setItem("x402_payment_token", manualToken);
          finalResponse = await fetch("/api/paid-data", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-PAYMENT": manualToken
            },
            credentials: "include",
            body
          });
        }
      }

      if (!finalResponse.ok) {
        const errorPayload = (await finalResponse.json().catch(async () => ({ error: await finalResponse.text().catch(() => "") }))) as { error?: string };
        throw new Error(errorPayload.error || `Paid strategy request failed (HTTP ${finalResponse.status})`);
      }

      const payload = (await finalResponse.json()) as {
        decision: AgentDecision;
        payment?: { settlementReference?: string };
        createdAt?: string;
        logs?: TimelineEvent[];
      };
      setDecision(payload.decision);
      if (Array.isArray(payload.logs)) setEvents(payload.logs);
      setLastPaidRunAt(payload.createdAt || new Date().toISOString());
      setPremiumUnlocked(true);
      await fetchOpportunities();
      addEvent(
        `Payment settled${payload.payment?.settlementReference ? ` (${payload.payment.settlementReference})` : ""}.`,
        "payment"
      );
      setInModalLoadingStep(3);
      addEvent("Strategy generated and validated from live APR inputs.", "decision");
      if (payload.decision.proofReceipt?.txHash) {
        const proofTxHash = payload.decision.proofReceipt.txHash;
        const newProofRecord: ProofRecord = {
          id: payload.decision.proofReceipt?.runId || Math.random().toString(36).slice(2),
          txHash: proofTxHash,
          timestamp: payload.decision.proofReceipt?.timestamp || new Date().toISOString(),
          action: payload.decision.action.toUpperCase(),
          protocol: payload.decision.selectedOpportunity?.protocol || "N/A",
          confidence: payload.decision.confidence,
          reason: payload.decision.reason
        };
        setProofs((prev) =>
          [
            newProofRecord,
            ...prev
          ].slice(0, 20)
        );
        addEvent(`On-chain proof submitted (${proofTxHash.slice(0, 12)}...)`, "proof");
      }
      const nextLatestRun: LatestRunMeta = {
        runId: payload.decision.runId || payload.decision.proofReceipt?.runId || Math.random().toString(36).slice(2),
        createdAt: payload.createdAt || new Date().toISOString(),
        paymentReference: payload.decision.proofReceipt?.paymentReference || "N/A",
        settlementReference: payload.decision.proofReceipt?.settlementReference || payload.payment?.settlementReference || "N/A",
        paymentConfirmed: true,
        proofConfirmed: Boolean(payload.decision.proofReceipt?.txHash),
        paymentTxHash: null,
        proofTxHash: payload.decision.proofReceipt?.txHash || null,
        paymentBlockNumber: null,
        proofBlockNumber: null,
        paymentExplorerUrl: null,
        proofExplorerUrl: payload.decision.proofReceipt?.txHash ? `${KITE_EXPLORER_BASE}/tx/${payload.decision.proofReceipt.txHash}` : null
      };
      setLatestRuns((prev) => [nextLatestRun, ...prev.filter((run) => run.runId !== nextLatestRun.runId)].slice(0, 5));
      setShowAgentModal(false);
      toast.dismiss(strategyToast);
      toast.success("Paid run completed. Strategy and proof are ready.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown paid-run error";
      setPaidRunError(message);
      addEvent(`Paid run failed: ${message}`, "payment");
      toast.dismiss(strategyToast);
      toast.error(message);
    } finally {
      setStatus("idle");
      setInModalLoadingStep(0);
    }
  };

  if (!enteredApp) {
    return (
      <div className="min-h-screen bg-[#080808] text-white overflow-x-hidden relative flex flex-col justify-between selection:bg-[#B3A288]/20 selection:text-[#B3A288]">
        {/* Ambient Glows */}
        <div className="absolute top-[-100px] left-[-150px] w-[600px] h-[600px] rounded-full bg-[#B3A288]/10 blur-[120px] pointer-events-none" />
        <div className="absolute bottom-[200px] right-[-200px] w-[700px] h-[700px] rounded-full bg-emerald-500/5 blur-[120px] pointer-events-none" />

        {/* Header */}
        <header className="w-full max-w-7xl mx-auto px-6 py-6 flex items-center justify-between relative z-50">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#B3A288]/40 to-[#080808] border border-[#B3A288]/30 flex items-center justify-center font-black text-lg text-[#f8dba8]">
              A
            </div>
            <span className="text-2xl font-black tracking-tight text-white">Alloc<span className="text-[#B3A288]">AI</span></span>
          </div>
          <nav className="hidden md:flex items-center gap-8 text-xs font-black tracking-[0.2em] uppercase text-gray-400">
            <a href="#capabilities" className="hover:text-white transition-colors">DApp Capabilities</a>
            <a href="/Presentation.html" target="_blank" rel="noopener noreferrer" className="hover:text-[#B3A288] transition-colors">Product Deck</a>
          </nav>
          <div>
            <button
              onClick={() => setEnteredApp(true)}
              className="px-5 py-2.5 rounded-xl text-xs font-black tracking-widest uppercase bg-gradient-to-r from-emerald-500/20 to-emerald-500/5 border border-emerald-500/50 text-emerald-400 hover:text-white hover:border-emerald-400 transition-all shadow-lg shadow-emerald-500/5"
            >
              Launch App ↗
            </button>
          </div>
        </header>

        {/* Hero Section */}
        <main className="flex-1 flex flex-col items-center justify-center relative z-40 px-6 pt-12 pb-24 text-center max-w-5xl mx-auto">
          <div className="flex flex-wrap justify-center gap-3 mb-8">
            <span className="px-4 py-1.5 rounded-full text-[11px] font-black tracking-[0.2em] uppercase border border-[#B3A288]/30 bg-[#B3A288]/5 text-[#B3A288]">◆ Kite Mainnet Native</span>
            <span className="px-4 py-1.5 rounded-full text-[11px] font-black tracking-[0.2em] uppercase border border-emerald-500/30 bg-emerald-500/5 text-emerald-400">● x402 Agent Payments Enabled</span>
            <span className="px-4 py-1.5 rounded-full text-[11px] font-black tracking-[0.2em] uppercase border border-blue-500/30 bg-blue-500/5 text-blue-400">Verified Proof Receipts</span>
          </div>

          <h1 className="text-5xl sm:text-6xl md:text-7xl font-black tracking-tight leading-[1.05] mb-8 max-w-4xl">
            The Kite-Native Yield <br /><span className="bg-gradient-to-r from-white via-white to-[#B3A288] bg-clip-text text-transparent">Intelligence Layer</span>
          </h1>

          <p className="text-base sm:text-lg text-gray-300 max-w-3xl leading-relaxed mb-12 font-medium">
            Discover high-alpha USDC stablecoin pockets across 7 leading chains instantly. Powered by deep DeFiLlama synchronization, interactive <strong>Thought Stream quant telemetry</strong>, integrated <strong>Lucid Bridge pre-filling</strong>, and true serverless persistent healing via real-time blockchain proof validation.
          </p>

          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 w-full max-w-md mx-auto">
            <button
              onClick={() => setEnteredApp(true)}
              className="w-full sm:w-auto px-8 py-4 rounded-xl text-xs font-black tracking-widest uppercase bg-gradient-to-br from-[#B3A288]/25 to-[#B3A288]/5 border border-[#B3A288]/55 text-[#f8dba8] hover:text-white hover:border-[#B3A288] transition-all shadow-xl shadow-[#B3A288]/5 flex items-center justify-center gap-2"
            >
              Launch DApp Live <span className="text-base">🚀</span>
            </button>
            <a
              href="/Presentation.html"
              target="_blank"
              rel="noopener noreferrer"
              className="w-full sm:w-auto px-8 py-4 rounded-xl text-xs font-black tracking-widest uppercase bg-[#151515]/80 border border-white/10 text-gray-300 hover:text-white transition-all text-center"
            >
              Read Product Deck 📄
            </a>
          </div>

          {/* Live Meta Strip */}
          <div className="mt-16 pt-8 border-t border-white/5 w-full max-w-2xl grid grid-cols-2 md:grid-cols-4 gap-6 text-center">
            <div>
              <p className="text-[9px] font-black uppercase tracking-[0.2em] text-gray-500">Live Yield Source</p>
              <p className="text-xs font-black text-gray-200 mt-1">DeFiLlama API</p>
            </div>
            <div>
              <p className="text-[9px] font-black uppercase tracking-[0.2em] text-gray-500">Supported Networks</p>
              <p className="text-xs font-black text-emerald-400 mt-1">7 Chains Monitored</p>
            </div>
            <div>
              <p className="text-[9px] font-black uppercase tracking-[0.2em] text-gray-500">Agent Settlement</p>
              <p className="text-xs font-black text-[#B3A288] mt-1">Passport x402 Protocol</p>
            </div>
            <div>
              <p className="text-[9px] font-black uppercase tracking-[0.2em] text-gray-500">Cryptographic Ledger</p>
              <p className="text-xs font-black text-blue-400 mt-1">Kitescan Anchor</p>
            </div>
          </div>
        </main>

        {/* Capabilities Showcase Section */}
        <section id="capabilities" className="w-full bg-[#0b0b0b] border-t border-white/5 py-24 relative z-40">
          <div className="max-w-7xl mx-auto px-6">
            <div className="text-center max-w-2xl mx-auto mb-20">
              <p className="text-[10px] font-black tracking-[0.3em] text-[#B3A288] uppercase mb-3">Architectural Excellence</p>
              <h2 className="text-3xl sm:text-4xl font-black tracking-tight">Showcase &amp; Core DApp Capabilities</h2>
              <p className="text-xs text-gray-400 mt-3 font-medium leading-relaxed">
                Engineered as a robust zero-maintenance environment for hackathon verification and continuous production telemetry.
              </p>
            </div>

            {/* Chain Support Strip */}
            <div className="mb-16 bg-[#121212]/50 border border-white/5 p-6 rounded-2xl flex flex-wrap items-center justify-around gap-6 backdrop-blur-md">
              <div className="text-[10px] font-black uppercase tracking-[0.2em] text-gray-500 w-full text-center pb-2 border-b border-white/5 mb-2">
                Real-Time USDC Multi-Chain Monitoring
              </div>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-[#B3A288]" />
                <span className="text-xs font-black tracking-wider text-white">KITE AI</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-blue-400" />
                <span className="text-xs font-black tracking-wider text-gray-300">ARBITRUM</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-red-400" />
                <span className="text-xs font-black tracking-wider text-gray-300">AVALANCHE</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-red-500" />
                <span className="text-xs font-black tracking-wider text-gray-300">OPTIMISM</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-blue-500" />
                <span className="text-xs font-black tracking-wider text-gray-300">BASE</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-yellow-400" />
                <span className="text-xs font-black tracking-wider text-gray-300">BSC</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-400" />
                <span className="text-xs font-black tracking-wider text-gray-300">CELO</span>
              </div>
            </div>

            {/* Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
              {/* Card 1 */}
              <div className="bg-[#151515]/85 border border-white/5 p-8 rounded-2xl flex flex-col justify-between relative overflow-hidden group hover:border-[#B3A288]/40 transition-all">
                <div className="absolute top-0 right-0 w-24 h-24 bg-[#B3A288]/5 rounded-bl-full group-hover:bg-[#B3A288]/10 transition-all" />
                <div>
                  <div className="w-10 h-10 rounded-xl bg-[#B3A288]/10 border border-[#B3A288]/20 flex items-center justify-center text-lg mb-6">
                    📊
                  </div>
                  <h3 className="text-base font-black tracking-tight mb-3">Live Yield Synchronization</h3>
                  <p className="text-xs text-gray-300 leading-relaxed font-medium">
                    Synchronizes continuously with the live DeFiLlama data pipeline. Captures top-ranked stablecoin pools natively, ensuring allocation metrics directly represent live active total value locked and highest sustainable yields.
                  </p>
                </div>
                <div className="mt-6 pt-4 border-t border-white/5 flex items-center justify-between text-[10px] font-black uppercase tracking-widest text-[#B3A288]">
                  <span>Filter</span>
                  <span className="text-gray-500">USDC Stablecoins</span>
                </div>
              </div>

              {/* Card 2 */}
              <div className="bg-[#151515]/85 border border-white/5 p-8 rounded-2xl flex flex-col justify-between relative overflow-hidden group hover:border-emerald-500/40 transition-all">
                <div className="absolute top-0 right-0 w-24 h-24 bg-emerald-500/5 rounded-bl-full group-hover:bg-emerald-500/10 transition-all" />
                <div>
                  <div className="w-10 h-10 rounded-xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center text-lg mb-6">
                    🔐
                  </div>
                  <h3 className="text-base font-black tracking-tight mb-3">Passport x402 Agentic Gate</h3>
                  <p className="text-xs text-gray-300 leading-relaxed font-medium">
                    Full compatibility with headless API queries. Returns standardized HTTP 402 multi-accept payment challenge blocks. Fully authenticates verified x402 token authorization payloads generated by external agent runtimes.
                  </p>
                </div>
                <div className="mt-6 pt-4 border-t border-white/5 flex items-center justify-between text-[10px] font-black uppercase tracking-widest text-emerald-400">
                  <span>Settle</span>
                  <span className="text-gray-500">0.25 USDC.e</span>
                </div>
              </div>

              {/* Card 3 */}
              <div className="bg-[#151515]/85 border border-white/5 p-8 rounded-2xl flex flex-col justify-between relative overflow-hidden group hover:border-blue-500/40 transition-all">
                <div className="absolute top-0 right-0 w-24 h-24 bg-blue-500/5 rounded-bl-full group-hover:bg-blue-500/10 transition-all" />
                <div>
                  <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-lg mb-6">
                    ⛓️
                  </div>
                  <h3 className="text-base font-black tracking-tight mb-3">On-Chain Cryptographic Proof</h3>
                  <p className="text-xs text-gray-300 leading-relaxed font-medium">
                    Every quantitative run executes a digital signature handshake and dispatches proof telemetry to Kitescan. Guarantees true auditability by permanently hashing the specific strategy payload and target APR parameters.
                  </p>
                </div>
                <div className="mt-6 pt-4 border-t border-white/5 flex items-center justify-between text-[10px] font-black uppercase tracking-widest text-blue-400">
                  <span>Ledger</span>
                  <span className="text-gray-500">Kite Explorer Anchor</span>
                </div>
              </div>

              {/* Card 4 */}
              <div className="bg-[#151515]/85 border border-white/5 p-8 rounded-2xl flex flex-col justify-between relative overflow-hidden group hover:border-purple-500/40 transition-all">
                <div className="absolute top-0 right-0 w-24 h-24 bg-purple-500/5 rounded-bl-full group-hover:bg-purple-500/10 transition-all" />
                <div>
                  <div className="w-10 h-10 rounded-xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-lg mb-6">
                    🌉
                  </div>
                  <h3 className="text-base font-black tracking-tight mb-3">Lucid Bridge Integration</h3>
                  <p className="text-xs text-gray-300 leading-relaxed font-medium">
                    Seamlessly connects pure research to direct on-chain execution. In-app navigation triggers automated target network mapping in the integrated Lucid Bridge component, reducing complex capital migration paths to single-click intents.
                  </p>
                </div>
                <div className="mt-6 pt-4 border-t border-white/5 flex items-center justify-between text-[10px] font-black uppercase tracking-widest text-purple-400">
                  <span>Suite</span>
                  <span className="text-gray-500">Bridge &amp; Swap Hooks</span>
                </div>
              </div>

              {/* Card 5 */}
              <div className="bg-[#151515]/85 border border-white/5 p-8 rounded-2xl flex flex-col justify-between relative overflow-hidden group hover:border-amber-500/40 transition-all">
                <div className="absolute top-0 right-0 w-24 h-24 bg-amber-500/5 rounded-bl-full group-hover:bg-amber-500/10 transition-all" />
                <div>
                  <div className="w-10 h-10 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center text-lg mb-6">
                    🧠
                  </div>
                  <h3 className="text-base font-black tracking-tight mb-3">Thought Stream Terminal UI</h3>
                  <p className="text-xs text-gray-300 leading-relaxed font-medium">
                    Real-time terminal visualization inside the decision module renders underlying quant calculations step-by-step. Exposes risk matrix parameters, slippage modeling, and LLM synthesis live during decision lock states.
                  </p>
                </div>
                <div className="mt-6 pt-4 border-t border-white/5 flex items-center justify-between text-[10px] font-black uppercase tracking-widest text-amber-400">
                  <span>Telemetry</span>
                  <span className="text-gray-500">Interactive Alpha Shell</span>
                </div>
              </div>

              {/* Card 6 */}
              <div className="bg-[#151515]/85 border border-white/5 p-8 rounded-2xl flex flex-col justify-between relative overflow-hidden group hover:border-rose-500/40 transition-all">
                <div className="absolute top-0 right-0 w-24 h-24 bg-rose-500/5 rounded-bl-full group-hover:bg-rose-500/10 transition-all" />
                <div>
                  <div className="w-10 h-10 rounded-xl bg-rose-500/10 border border-rose-500/20 flex items-center justify-center text-lg mb-6">
                    🛡️
                  </div>
                  <h3 className="text-base font-black tracking-tight mb-3">Serverless Persistence Recovery</h3>
                  <p className="text-xs text-gray-300 leading-relaxed font-medium">
                    Eliminates transient session degradation. When static container memory clears, the backend autonomously reads the transaction ledger directly from Kitescan via robust summary decoding, instantly restoring full timeline consistency.
                  </p>
                </div>
                <div className="mt-6 pt-4 border-t border-white/5 flex items-center justify-between text-[10px] font-black uppercase tracking-widest text-rose-400">
                  <span>Hardening</span>
                  <span className="text-gray-500">Zero-Maintenance State</span>
                </div>
              </div>
            </div>

            <div className="mt-16 text-center">
              <button
                onClick={() => setEnteredApp(true)}
                className="inline-flex items-center gap-2 text-xs font-black tracking-[0.2em] uppercase text-[#B3A288] hover:text-white underline decoration-[#B3A288]/40 transition-all"
              >
                Experience Verifiable Alpha on Kite AI ↗
              </button>
            </div>
          </div>
        </section>

        {/* Footer */}
        <footer className="w-full border-t border-white/5 py-8 text-center text-xs text-gray-600 uppercase tracking-[0.2em] font-black bg-[#050505] relative z-40">
          <div className="max-w-7xl mx-auto px-6 flex flex-col sm:flex-row items-center justify-between gap-4">
            <span>AllocAI © 2026</span>
            <span className="text-[#B3A288]/60">Kite Hackathon MVP Submission</span>
            <div className="flex gap-6">
              <a href="/Presentation.html" target="_blank" rel="noopener noreferrer" className="hover:text-gray-400 transition-colors">Product Deck</a>
              <button onClick={() => setEnteredApp(true)} className="hover:text-gray-400 transition-colors">Launch DApp</button>
            </div>
          </div>
        </footer>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-[#080808] pb-24 overflow-x-hidden relative">
      <EtheralShadow color="rgba(179, 162, 136, 0.15)" animation={{ scale: 80, speed: 10 }} noise={{ opacity: 0.2, scale: 1.5 }} sizing="fill" />
      <div className="relative z-10 container mx-auto px-6 pt-12 max-w-7xl">
        <div className="flex flex-col lg:flex-row items-end lg:items-center justify-between mb-12 px-2 gap-8">
          <Header />
          <WalletPanel />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-4 gap-6 mb-8">
          <div className="glass-card p-8 rounded-[2rem] border-white/10">
            <p className="text-[9px] font-black text-gray-500 uppercase tracking-widest mb-2">Best APR</p>
            <p className="text-3xl font-black text-[#B3A288]">{topApr.toFixed(2)}%</p>
          </div>
          <div className="glass-card p-8 rounded-[2rem] border-white/10">
            <p className="text-[9px] font-black text-gray-500 uppercase tracking-widest mb-2">Tracked Routes</p>
            <p className="text-3xl font-black text-white">{opportunities.length}</p>
          </div>
          <div className="glass-card p-8 rounded-[2rem] border-white/10">
            <p className="text-[9px] font-black text-gray-500 uppercase tracking-widest mb-3">Agent Control</p>
            <button
              onClick={() => setShowAgentModal(true)}
              className="w-full py-3 rounded-xl bg-[#B3A288] text-black text-[10px] font-black uppercase tracking-[0.2em]"
            >
              Run The Agent
            </button>
          </div>
          <div className="glass-card p-8 rounded-[2rem] border-white/10">
            <p className="text-[9px] font-black text-gray-500 uppercase tracking-widest mb-2">KPI Snapshot</p>
            <p className="text-2xl font-black text-[#B3A288]">
              {kpis &&
              kpis.kpiSource === "none" &&
              kpis.totalRuns === 0 &&
              kpis.proofsPosted === 0
                ? "--"
                : kpis
                  ? `${kpis.successRate.toFixed(1)}%`
                  : "--"}
            </p>
            <p className="text-[8px] font-black uppercase tracking-widest text-gray-500 mt-2">
              success · proofs {kpis?.proofsPosted ?? 0} · avg{" "}
              {kpis && kpis.avgResponseMs > 0 ? `${kpis.avgResponseMs}ms` : "--"}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-12 gap-8 mb-8 items-stretch">
          <div className="xl:col-span-8">
            <div className="glass-card rounded-[2rem] overflow-hidden h-full">
              <div className="p-8 border-b border-white/10 flex justify-between items-center bg-white/5">
                <h3 className="text-xs font-black uppercase tracking-widest text-[#B3A288]">USDC Yield Dashboard</h3>
                <span suppressHydrationWarning className="text-[9px] font-bold text-gray-500 uppercase">
                  Lucid-Reachable Cross-Chain Routes (Live Source: DeFiLlama)
                </span>
              </div>
              <YieldTable opportunities={opportunities} loading={loading} unlocked={premiumUnlocked} />
            </div>
          </div>
          <div className="xl:col-span-4">
            <div className="relative h-full">
              {activeActionTab === "swap" ? (
                <QuickSwap
                  signer={signer}
                  address={address || ""}
                  onToggleMode={() => setActiveActionTab("bridge")}
                  toggleLabel="toggle to Bridge"
                />
              ) : (
                <LucidBridge
                  signer={signer}
                  address={address || ""}
                  onToggleMode={() => setActiveActionTab("swap")}
                  toggleLabel="toggle to Swap"
                  prefilledChain={bridgePrefill?.chain}
                />
              )}
            </div>
          </div>
        </div>

        <div ref={decisionSectionRef} className="grid grid-cols-1 xl:grid-cols-12 gap-8 mb-8 items-stretch">
          <div className="xl:col-span-12">
            <DecisionPanel
              decision={decision}
              latestHistoryDecision={proofs[0]}
              status={status}
              onRunAgent={handleRunAgent}
              onPrepareBridge={(chain) => {
                setBridgePrefill({ chain });
                setActiveActionTab("bridge");
                toast.success(`BRIDGE PREPARED`, { description: `Destination set to ${chain}. Enter amount to begin.` });
              }}
            />
          </div>
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-12 gap-8 mb-8 items-stretch">
          <div className="xl:col-span-8">
            <Timeline events={events} latestRuns={latestRuns} />
          </div>
          <div className="xl:col-span-4">
            <div className="space-y-8 h-full">
              <div className="glass-card p-6 rounded-[2rem] border-white/10 bg-[#151515] relative overflow-hidden">
                <h3 className="text-[10px] font-black uppercase tracking-[0.25em] text-[#B3A288] mb-4">Autonomous Test Portfolio</h3>
                <p className="text-[8px] font-black uppercase tracking-[0.15em] text-gray-500 mb-2">
                  {autonomousStatus?.profileLabel || "Generic Autonomous High-Conviction Basket"}
                </p>
                <p className="text-[10px] font-black text-gray-200">
                  Every {autonomousStatus?.intervalHours ?? 24}h · {autonomousStatus?.testPortfolioUsdc ?? 25000} USDC
                </p>
                <p className="text-[11px] font-black text-white mt-2">
                  Next run in: {formatCountdown(autonomousStatus?.nextRunAt || null, countdownNowMs)}
                </p>
                {autonomousStatus?.latest ? (
                  <div className="mt-3 rounded-xl bg-[#080808] border border-white/10 p-3">
                    <p className="text-[8px] font-black uppercase tracking-[0.15em] text-gray-500">
                      Latest run {autonomousStatus.latest.runId.slice(0, 10)}...
                    </p>
                    <p className="text-[10px] font-black text-white mt-1">
                      {autonomousStatus.latest.decision?.strategy?.headline || autonomousStatus.latest.decision?.reason || "No narrative yet"}
                    </p>
                    <div className="flex items-center gap-3 mt-2">
                      <p className="text-[10px] font-black text-emerald-400">
                        APR {autonomousStatus.latest.decision?.strategy?.apr ?? autonomousStatus.baselineApr}%
                      </p>
                      {autonomousStatus.latest.decision?.proofReceipt?.txHash && (
                        <a 
                          href={`https://kitescan.ai/tx/${autonomousStatus.latest.decision.proofReceipt.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[8px] font-black uppercase tracking-widest text-[#B3A288] hover:text-white transition-colors"
                        >
                          View Proof ↗
                        </a>
                      )}
                    </div>
                    <p className="text-[7px] font-black uppercase tracking-[0.15em] text-gray-500 mt-2">
                      Response {autonomousStatus.latest.responseTimeMs ?? 0} ms · {autonomousStatus.latest.success ? "success" : "failed"}
                    </p>
                  </div>
                ) : (
                  <p className="text-[9px] font-black uppercase tracking-[0.15em] text-gray-500 mt-3">
                    No autonomous run yet.
                  </p>
                )}
              </div>
              <div className="glass-card p-8 rounded-[2rem] border-white/10 bg-[#151515] relative overflow-hidden">
                <div className="absolute left-5 top-6 h-14 w-px bg-gradient-to-b from-[#B3A288]/45 to-transparent" />
                <div className="absolute right-5 bottom-6 h-14 w-px bg-gradient-to-t from-[#B3A288]/45 to-transparent" />
                <div className="absolute right-8 top-6 text-[#B3A288]/30 text-[9px] font-black tracking-[0.25em]">◉</div>
                <h3 className="text-[10px] font-black uppercase tracking-[0.25em] text-[#B3A288] mb-6">USDC by Chain</h3>
                <div className="space-y-3">
                  {balancesLoading && chainBalances.length === 0 ? (
                    <p className="text-[9px] font-black uppercase tracking-widest text-gray-500">Loading balances...</p>
                  ) : (
                    chainBalances.map((item) => (
                      <div key={item.chain} className="bg-[#080808] border border-white/10 rounded-xl px-4 py-3 flex items-center justify-between">
                        <div className="flex items-center gap-2.5 min-w-0">
                          <div className="relative w-7 h-5">
                            <img src={USDC_LOGO} alt="USDC" className="w-4 h-4 rounded-full absolute left-0 top-0 border border-white/10" />
                            <img
                              src={CHAIN_LOGOS[item.chain] || "https://icons.llama.fi/ethereum.png"}
                              alt={item.chain}
                              className={`w-4 h-4 rounded-full absolute left-3 top-1 border border-white/10 ${
                                item.chain === "Arbitrum" ? "bg-white/90 p-[1px] shadow-[0_0_10px_rgba(255,255,255,0.65)]" : ""
                              }`}
                            />
                          </div>
                          <span className="text-[9px] font-black uppercase tracking-widest text-gray-400 truncate">
                            USDC · {item.chain}
                          </span>
                        </div>
                        <span className="text-[10px] font-black text-white">
                          {item.status === "ok" && item.balance !== null ? `${item.balance.toFixed(4)} USDC` : "Unavailable"}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>

        {showAgentModal && (
          <div className="fixed inset-0 z-[120] flex items-center justify-center p-6">
            <div className="absolute inset-0 bg-black/80 backdrop-blur-sm" onClick={() => setShowAgentModal(false)} />
            <div className="relative z-10 w-full max-w-xl glass-card rounded-[2rem] border border-white/10 bg-[#151515] p-8">
              <h3 className="text-[11px] font-black uppercase tracking-[0.25em] text-[#B3A288] mb-6">Run The Agent</h3>
              <div className="space-y-4">
                <div>
                  <label className="text-[9px] font-black uppercase tracking-widest text-gray-400 block mb-2">
                    Portfolio Size to Simulate (USDC)
                  </label>
                  <input
                    type="number"
                    value={paidStakeAmount}
                    onChange={(e) => setPaidStakeAmount(e.target.value)}
                    className="w-full bg-[#080808] border border-white/10 rounded-xl px-4 py-3 text-[10px] font-mono text-white placeholder:text-[9px] placeholder:text-gray-500"
                    placeholder="e.g. 1000 USDC"
                  />
                </div>
                <div>
                  <label className="text-[9px] font-black uppercase tracking-widest text-gray-400 block mb-2">
                    Risk Profile
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setPaidRisk("low")}
                      className={`rounded-xl border px-3 py-2 text-[9px] font-black uppercase tracking-wide transition-colors ${
                        paidRisk === "low"
                          ? "border-[#B3A288]/70 bg-[#B3A288]/15 text-[#B3A288]"
                          : "border-white/10 bg-[#080808] text-gray-400 hover:border-white/20"
                      }`}
                    >
                      Low Risk
                    </button>
                    <button
                      type="button"
                      onClick={() => setPaidRisk("medium")}
                      className={`rounded-xl border px-3 py-2 text-[9px] font-black uppercase tracking-wide transition-colors ${
                        paidRisk === "medium"
                          ? "border-[#B3A288]/70 bg-[#B3A288]/15 text-[#B3A288]"
                          : "border-white/10 bg-[#080808] text-gray-400 hover:border-white/20"
                      }`}
                    >
                      Medium Risk
                    </button>
                  </div>
                </div>
                <div>
                  <label className="text-[9px] font-black uppercase tracking-widest text-gray-400 block mb-2">
                    Payment Mode
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setPaymentMode("direct")}
                      className={`rounded-xl border px-3 py-2 text-[9px] font-black uppercase tracking-wide transition-colors ${
                        paymentMode === "direct"
                          ? "border-[#B3A288]/70 bg-[#B3A288]/15 text-[#B3A288]"
                          : "border-white/10 bg-[#080808] text-gray-400 hover:border-white/20"
                      }`}
                    >
                      Direct
                    </button>
                    <button
                      type="button"
                      onClick={() => setPaymentMode("x402")}
                      className={`rounded-xl border px-3 py-2 text-[9px] font-black uppercase tracking-wide transition-colors ${
                        paymentMode === "x402"
                          ? "border-[#B3A288]/70 bg-[#B3A288]/15 text-[#B3A288]"
                          : "border-white/10 bg-[#080808] text-gray-400 hover:border-white/20"
                      }`}
                    >
                      x402 Passport
                    </button>
                  </div>
                </div>
                <div className="bg-[#080808] border border-white/10 rounded-xl p-3">
                  <p className="text-[8px] font-black uppercase tracking-[0.2em] text-gray-500 mb-2">
                    {paymentMode === "direct" ? "Direct KITE Pre-Check" : "x402 Token Pre-Check"}
                  </p>
                  <p className="text-[9px] font-black text-gray-300">
                    Required:{" "}
                    <span className="text-white">
                      {paymentRequirement
                        ? paymentMode === "direct"
                          ? `${Number(ethers.formatEther(requiredByModeUnits)).toFixed(4)} KITE`
                          : `${Number(ethers.formatUnits(requiredByModeUnits, 6)).toFixed(4)} USDC.e`
                        : "..."}
                    </span>
                  </p>
                  <p className="text-[9px] font-black text-gray-300 mt-1">
                    Your Balance:{" "}
                    <span className="text-white">
                      {paymentBalanceLoading
                        ? "Loading..."
                        : activeBalanceWei !== null
                          ? paymentMode === "direct"
                            ? `${Number(ethers.formatEther(activeBalanceWei)).toFixed(4)} KITE`
                            : `${Number(ethers.formatUnits(activeBalanceWei, 6)).toFixed(4)} USDC.e`
                          : "Unavailable"}
                    </span>
                  </p>
                  {!paymentBalanceLoading && activeBalanceWei !== null && !hasSufficientBalance ? (
                    <p className="mt-2 text-[8px] font-black uppercase tracking-[0.15em] text-red-300">
                      {paymentMode === "direct"
                        ? "Insufficient KITE balance for direct payment."
                        : "Insufficient USDC.e balance for x402 payment."}
                    </p>
                  ) : null}
                </div>
              </div>
              <div className="mt-8 grid grid-cols-2 gap-3">
                <button
                  onClick={() => setShowAgentModal(false)}
                  disabled={status === "purchasing"}
                  className="w-full py-3 rounded-xl bg-white/5 border border-white/10 text-[9px] font-black uppercase tracking-[0.2em] text-gray-300"
                >
                  Cancel
                </button>
                <button
                  onClick={handlePaidRun}
                  disabled={status !== "idle" || !readyForPayment}
                  className="w-full py-3 rounded-xl bg-purple-500/20 text-purple-200 text-[9px] font-black uppercase tracking-[0.2em] border border-purple-500/20 disabled:opacity-40"
                >
                  Pay 0.25 KITE & Run Agent
                </button>
              </div>
              {status === "purchasing" ? (
                <div className="mt-4 rounded-xl border border-[#B3A288]/25 bg-[#080808] p-3">
                  <div className="flex items-center gap-3">
                    <div className="w-4 h-4 rounded-full border-2 border-white/15 border-t-[#B3A288] animate-spin" />
                    <p className="text-[9px] font-black uppercase tracking-[0.15em] text-[#B3A288]">
                      {inModalLoadingStep === 0 && "Preparing payment request..."}
                      {inModalLoadingStep === 1 && "Waiting for wallet/payment authorization..."}
                      {inModalLoadingStep === 2 && "Payment sent. Waiting confirmation..."}
                      {inModalLoadingStep >= 3 && "Generating strategy and on-chain proof..."}
                    </p>
                  </div>
                </div>
              ) : null}
              {paidRunError ? (
                <p className="mt-4 text-[9px] font-black uppercase tracking-[0.15em] text-red-300">
                  {paidRunError}
                </p>
              ) : (
                <p className="mt-4 text-[8px] font-black uppercase tracking-[0.15em] text-gray-500">
                  {paymentMode === "direct"
                    ? "Direct mode: wallet sends KITE payment and backend verifies tx."
                    : "x402 mode: requires Kite Passport payment session or valid X-PAYMENT token."}
                </p>
              )}
            </div>
          </div>
        )}

        <footer className="mt-24 mb-12 flex flex-col items-center opacity-40">
          <div className="w-10 h-px bg-[#B3A288]/20 mb-8" />
          <p className="text-[#B3A288] text-[8px] font-black uppercase tracking-[0.8em]">AllocAI HUB</p>
        </footer>
      </div>
    </main>
  );
}
