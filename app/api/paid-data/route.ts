import { NextResponse } from "next/server";
import { ethers } from "ethers";
import { determineDecision } from "@/lib/decision-engine";
import { verifyDirectPaymentOnChain } from "@/lib/direct-payment";
import { settleX402Payment } from "@/lib/facilitator";
import { applyGuardrails, getGuardrailPolicy } from "@/lib/guardrails";
import { publishRunProofAndSignReceipt } from "@/lib/proof-receipt";
import { getDefiLlamaProtocolUrl, getProtocolStrategyUrl } from "@/lib/protocol-links";
import { savePaidRun } from "@/lib/run-store";
import { generateStrategyNarrative } from "@/lib/strategy-llm";
import { MOCK_YIELDS, YieldOpportunity } from "@/lib/types";
import {
  buildSettlementId,
  buildX402Challenge,
  isLikelyHexSignature,
  parseXPaymentHeader
} from "@/lib/x402";

interface PaidDataRequest {
  currentApr?: number;
  opportunities?: YieldOpportunity[];
  tvl?: number;
  amountUsdc?: number;
  risk?: "low" | "medium";
  payerAddress?: string;
}

function maybeAddress(value: unknown): string | null {
  return typeof value === "string" && ethers.isAddress(value) ? value : null;
}

function extractPayerAddress(bodyAddress: string | undefined, authorization: Record<string, unknown> | undefined): string | null {
  const direct = maybeAddress(bodyAddress);
  if (direct) return direct;
  if (!authorization) return null;

  const candidates: unknown[] = [
    authorization.payer,
    authorization.payerAddress,
    authorization.payer_addr,
    authorization.from,
    authorization.sender,
    authorization.account,
    authorization.address,
    (authorization.payer as Record<string, unknown> | undefined)?.address,
    (authorization.authorization as Record<string, unknown> | undefined)?.payer,
    (authorization.authorization as Record<string, unknown> | undefined)?.payerAddress,
    (authorization.authorization as Record<string, unknown> | undefined)?.from
  ];

  for (const candidate of candidates) {
    const addr = maybeAddress(candidate);
    if (addr) return addr;
  }
  return null;
}

function getResourceUrl(req: Request): string {
  const url = new URL(req.url);
  return `${url.origin}/api/paid-data`;
}

export async function POST(req: Request) {
  const startedAt = Date.now();
  const directPaymentTxHash = req.headers.get("X-DIRECT-PAYMENT-TX");
  const paymentHeader = req.headers.get("X-PAYMENT");
  const parsedPayment = parseXPaymentHeader(paymentHeader);
  const resource = getResourceUrl(req);
  const body = (await req.json().catch(() => ({}))) as PaidDataRequest;
  const opportunities = body.opportunities && body.opportunities.length ? body.opportunities : MOCK_YIELDS;
  const currentApr = typeof body.currentApr === "number" ? body.currentApr : opportunities[0]?.apr || 0;
  const tvl = typeof body.tvl === "number" && Number.isFinite(body.tvl) ? body.tvl : 0;
  const amountUsdc = typeof body.amountUsdc === "number" && Number.isFinite(body.amountUsdc) ? body.amountUsdc : tvl;
  const risk = body.risk === "medium" ? "medium" : "low";

  const challenge = buildX402Challenge(resource);
  const paymentRequest = challenge.accepts[0];

  let paymentReference = "";
  let settlementReference = "";
  const payerAddress = extractPayerAddress(body.payerAddress, parsedPayment?.authorization);

  if (directPaymentTxHash) {
    const verification = await verifyDirectPaymentOnChain({
      txHash: directPaymentTxHash,
      expectedPayTo: paymentRequest.payTo,
      minAmountWei: paymentRequest.maxAmountRequired,
      expectedPayer: body.payerAddress
    });
    if (!verification.ok) {
      return NextResponse.json(
        {
          error: verification.error || "Direct payment verification failed"
        },
        { status: 402 }
      );
    }
    paymentReference = verification.paymentReference;
    settlementReference = verification.settlementReference;
    console.log(`[direct-payment] verified tx=${directPaymentTxHash}`);
  } else {
    if (!parsedPayment) {
      return NextResponse.json(challenge, { status: 402 });
    }
    if (!isLikelyHexSignature(parsedPayment.signature)) {
      return NextResponse.json(
        {
          error: "Invalid X-PAYMENT token signature format"
        },
        { status: 400 }
      );
    }
    const settlementId = buildSettlementId(parsedPayment);
    console.log(`[x402] payment verification started id=${settlementId} network=${parsedPayment.network}`);
    const settlement = await settleX402Payment(parsedPayment, settlementId);
    if (!settlement.ok) {
      console.error(`[x402] settlement failed id=${settlementId} status=${settlement.status}`, settlement.raw);
      return NextResponse.json(
        {
          error: settlement.errorMessage || "Payment settlement failed",
          settlementStatus: settlement.status
        },
        { status: 402 }
      );
    }
    paymentReference = settlementId;
    settlementReference = settlement.settlementReference;
  }

  const sourceChain = process.env.AGENT_SOURCE_CHAIN || "Kite AI";
  const baseDecision = determineDecision(opportunities, currentApr, tvl, sourceChain, true);
  const guardrailPolicy = getGuardrailPolicy();
  const guarded = applyGuardrails(baseDecision, { amountUsdc, policy: guardrailPolicy });
  const strategy = await generateStrategyNarrative({
    amountUsdc,
    riskProfile: risk,
    decision: guarded.decision,
    opportunities
  });

  const runId = ethers.hexlify(ethers.randomBytes(16));
  const proofReceipt = await publishRunProofAndSignReceipt({
    runId,
    paymentReference,
    settlementReference,
    strategy
  });

  console.log(`[paid-run] complete runId=${runId} settleRef=${settlementReference} tx=${proofReceipt.txHash}`);
  const strategyRunLink = `${new URL(req.url).origin}/?strategyRun=${runId}`;
  const protocolHint = [
    guarded.decision.selectedOpportunity?.protocol || "",
    strategy.headline || "",
    strategy.recommendation || ""
  ]
    .filter(Boolean)
    .join(" ");
  const directPoolUrl = guarded.decision.selectedOpportunity?.strategyUrl;
  const strategyProtocolUrl = directPoolUrl
    ? directPoolUrl
    : protocolHint.length > 0
      ? getProtocolStrategyUrl(protocolHint, guarded.decision.selectedOpportunity?.chain || "")
      : null;
  const strategyDefiLlamaUrl =
    guarded.decision.selectedOpportunity?.defillamaUrl ||
    (protocolHint.length > 0 ? getDefiLlamaProtocolUrl(protocolHint) : null);
  const decisionPayload = {
    ...guarded.decision,
    strategyProtocolUrl: strategyProtocolUrl || undefined,
    strategyDefiLlamaUrl: strategyDefiLlamaUrl || undefined,
    strategy,
    proofReceipt,
    paymentStatus: "settled" as const,
    runId,
    strategyLink: strategyRunLink
  };
  const createdAt = new Date().toISOString();
  const runLogs = [
    {
      id: `${runId}-1`,
      timestamp: createdAt,
      message: directPaymentTxHash ? "Direct KITE payment verified." : "x402 payment settled.",
      type: "payment" as const
    },
    {
      id: `${runId}-2`,
      timestamp: createdAt,
      message: `Strategy generated for ${decisionPayload.selectedOpportunity?.protocol || "selected protocol"}.`,
      type: "decision" as const
    },
    {
      id: `${runId}-3`,
      timestamp: createdAt,
      message: `On-chain proof anchored (${proofReceipt.txHash.slice(0, 12)}...).`,
      type: "proof" as const
    },
    ...(proofReceipt.summaryTxHash
      ? [
          {
            id: `${runId}-4`,
            timestamp: createdAt,
            message: `On-chain summary anchored (${proofReceipt.summaryTxHash.slice(0, 12)}...).`,
            type: "proof" as const
          }
        ]
      : [])
  ];
  savePaidRun({
    runId,
    payerAddress,
    paymentReference,
    settlementReference,
    paymentTo: paymentRequest.payTo,
    decision: decisionPayload,
    logs: runLogs,
    createdAt,
    runType: "paid",
    success: true,
    responseTimeMs: Date.now() - startedAt
  });

  return NextResponse.json({
    success: true,
    createdAt,
    payment: {
      status: "settled",
      settlementReference,
      paymentReference
    },
    strategyLink: strategyProtocolUrl || strategyRunLink,
    strategyRunLink,
    logs: runLogs,
    decision: decisionPayload
  });
}
