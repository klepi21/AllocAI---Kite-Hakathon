import { YieldOpportunity, AgentDecision, AgentAction } from "./types";

export const determineDecision = (
  opportunities: YieldOpportunity[],
  currentApr: number = 5.0,
  tvl: number = 0,
  sourceChain: string = "Kite AI",
  paidDataUsed: boolean = false,
  riskMode: "standard" | "aggressive" = "standard"
): AgentDecision => {
  // Filter for allowed risk levels
  const safeOpportunities =
    riskMode === "aggressive"
      ? opportunities
      : opportunities.filter((opp) => opp.risk === "low" || opp.risk === "medium");

  // Sort by APR descending
  const sorted = [...safeOpportunities].sort((a, b) => b.apr - a.apr);
  const best = sorted[0];

  if (!best) {
    return {
      action: "hold",
      reason: "No suitable yield opportunities found that match risk parameters.",
      confidence: 1.0,
      paidDataUsed,
    };
  }

  // --- STARGATE OPTIMIZED FEE CALCULATION ---
  const isCrossChain = best.chain !== sourceChain;
  
  // 1. LayerZero/Stargate Protocol Fee (0.06% of TVL)
  const protocolFee = isCrossChain ? (tvl * 0.0006) : 0;
  
  // 2. Base Gas Fee (Varies by Source Chain)
  let sourceGasFee = 0;
  if (isCrossChain) {
    if (sourceChain === "Ethereum") sourceGasFee = 15;
    else if (sourceChain === "Kite AI") sourceGasFee = 0.50; // Ultra low gas on Kite
    else sourceGasFee = 1.50; // Standard L2 (Arbitrum/Base)
  }

  const totalEstimatedCost = protocolFee + sourceGasFee;
  
  // Projected Gross Profit Increase (1 Year)
  const projectedExtraProfit = (tvl * (best.apr - currentApr)) / 100;
  const netProfit = projectedExtraProfit - totalEstimatedCost;
  
  // Success Metric: If net profit is positive and covers the move cost at least 3x
  const requiredProfitMultiple = riskMode === "aggressive" ? 1.25 : 2;
  const isWorthIt = !isCrossChain || netProfit > totalEstimatedCost * requiredProfitMultiple;

  const threshold = currentApr + (riskMode === "aggressive" ? 0.6 : 1.25); // Aggressive mode reacts earlier

  if (best.apr > threshold && isWorthIt) {
    return {
      action: "move",
      to: `${best.chain} - ${best.protocol}`,
      reason: `Optimized Stargate Move: Yield Spike to ${best.apr}%. Projected net yield of $${netProfit.toFixed(2)} after fees ($${totalEstimatedCost.toFixed(2)}).`,
      confidence: paidDataUsed ? 0.95 : 0.85,
      selectedOpportunity: best,
      paidDataUsed,
    };
  }

  if (best.apr > threshold && !isWorthIt) {
    return {
      action: "hold",
      reason: `Found higher yield (${best.apr}%), but the ${sourceChain} gas + LayerZero protocol fees ($${totalEstimatedCost.toFixed(2)}) would consume too much of the profit at our current TVL.`,
      confidence: 0.9,
      selectedOpportunity: best,
      paidDataUsed,
    };
  }

  return {
    action: "hold",
    reason: `Current APR of ${currentApr}% remains optimal for our portfolio risk-profile.`,
    confidence: paidDataUsed ? 0.98 : 0.9,
    selectedOpportunity: best,
    paidDataUsed,
  };
};
