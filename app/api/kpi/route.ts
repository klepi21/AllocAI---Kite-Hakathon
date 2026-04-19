import { NextResponse } from "next/server";
import { ethers } from "ethers";
import { getAllRuns } from "@/lib/run-store";
import {
  decodeAllocaiFullSummary,
  fetchKitescanAddressTransactions,
  getServiceWalletAddress,
  kitescanAddressLower,
  txSucceeded
} from "@/lib/kitescan-fetch";

export async function GET() {
  const runs = getAllRuns();
  const paidRunsStore = runs.filter((run) => (run.runType || "paid") === "paid");
  const autonomousRuns = runs.filter((run) => run.runType === "autonomous");
  const successRuns = runs.filter((run) => run.success !== false);
  const responseSamples = runs
    .map((run) => run.responseTimeMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));

  const avgResponseMs = responseSamples.length
    ? Math.round(responseSamples.reduce((acc, value) => acc + value, 0) / responseSamples.length)
    : 0;

  const proofsStore = runs.filter((run) => Boolean(run.decision.proofReceipt?.txHash)).length;

  const payTo = process.env.X402_PAY_TO_ADDRESS || "";
  const minKiteWei = BigInt(process.env.DIRECT_KITE_FEE_WEI || "0");
  const serviceAddr = getServiceWalletAddress();

  let explorerPaidOk = 0;
  let explorerPaidFail = 0;
  let explorerProofRunIds = new Set<string>();
  let explorerProofOk = 0;
  let explorerProofFail = 0;

  if (payTo && ethers.isAddress(payTo) && minKiteWei > 0n) {
    const txs = await fetchKitescanAddressTransactions(payTo, 100);
    const payToLower = payTo.toLowerCase();
    for (const tx of txs) {
      const to = kitescanAddressLower(tx.to);
      const from = kitescanAddressLower(tx.from);
      if (to !== payToLower || from === payToLower) continue;
      let value = 0n;
      try {
        value = BigInt(tx.value || "0");
      } catch {
        continue;
      }
      if (value < minKiteWei) continue;
      if (txSucceeded(tx)) explorerPaidOk += 1;
      else explorerPaidFail += 1;
    }
  }

  if (serviceAddr) {
    const txs = await fetchKitescanAddressTransactions(serviceAddr, 100);
    const svcLower = serviceAddr.toLowerCase();
    for (const tx of txs) {
      const from = kitescanAddressLower(tx.from);
      if (from !== svcLower) continue;
      const onChainData = decodeAllocaiFullSummary(tx.raw_input);
      if (!onChainData?.runId) continue;
      explorerProofRunIds.add(onChainData.runId);
      if (txSucceeded(tx)) explorerProofOk += 1;
      else explorerProofFail += 1;
    }
  }

  const proofsPosted = Math.max(proofsStore, explorerProofRunIds.size);
  const paidRuns = Math.max(paidRunsStore.length, explorerPaidOk);
  const totalRuns = paidRuns + autonomousRuns.length;

  let successRate: number;
  let kpiSource: "store" | "explorer" | "merged" | "none";

  if (runs.length > 0) {
    successRate = Number(((successRuns.length / runs.length) * 100).toFixed(2));
    kpiSource = explorerProofRunIds.size > 0 || explorerPaidOk > 0 ? "merged" : "store";
  } else {
    const ok = explorerPaidOk + explorerProofOk;
    const fail = explorerPaidFail + explorerProofFail;
    const denom = ok + fail;
    if (denom > 0) {
      successRate = Number(((ok / denom) * 100).toFixed(2));
      kpiSource = "explorer";
    } else if (explorerPaidOk > 0 || explorerProofRunIds.size > 0) {
      successRate = 100;
      kpiSource = "explorer";
    } else {
      successRate = 0;
      kpiSource = "none";
    }
  }

  return NextResponse.json({
    totalRuns,
    paidRuns,
    autonomousRuns: autonomousRuns.length,
    proofsPosted,
    avgResponseMs,
    successRate,
    kpiSource
  });
}
