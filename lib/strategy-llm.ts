import { AgentDecision, StrategyNarrative, YieldOpportunity } from "@/lib/types";

interface GenerateStrategyInput {
  amountUsdc: number;
  riskProfile: "low" | "medium";
  decision: AgentDecision;
  opportunities: YieldOpportunity[];
}

function buildCompoundedProjections(principalUsdc: number, apr: number): StrategyNarrative["compoundedProjections"] {
  const safePrincipal = principalUsdc > 0 ? principalUsdc : 0;
  const monthlyRate = apr / 100 / 12;
  return [2, 3, 5].map((years) => {
    const periods = years * 12;
    const projectedValueUsdc = safePrincipal * Math.pow(1 + monthlyRate, periods);
    return {
      years,
      projectedValueUsdc,
      projectedYieldUsdc: projectedValueUsdc - safePrincipal
    };
  });
}

function sanitizeJsonCandidate(raw: string): string {
  const fenced = raw.match(/```json\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1];
  const block = raw.match(/\{[\s\S]*\}/);
  if (block?.[0]) return block[0];
  return raw;
}

function buildFallbackNarrative(input: GenerateStrategyInput): StrategyNarrative {
  const opp = input.decision.selectedOpportunity;
  const apr = opp?.apr ?? 0;
  const monthly = (input.amountUsdc * (apr / 100)) / 12;
  const annual = input.amountUsdc * (apr / 100);
  const protocol = opp?.protocol || "the current strategy route";
  const chain = opp?.chain || "Kite";

  return {
    headline: `Stake to ${protocol} on ${chain} for ${apr.toFixed(2)}% APR`,
    recommendation: `Allocate ${input.amountUsdc.toFixed(2)} USDC into ${protocol} where the live APR is ${apr.toFixed(
      2
    )}%. Projected yield is ${monthly.toFixed(2)} USDC monthly if rates stay stable.`,
    expectedMonthlyUsdc: monthly,
    expectedAnnualUsdc: annual,
    apr,
    reinvestCadence: input.riskProfile === "low" ? "Reinvest every 30 days" : "Reinvest every 14 days",
    riskNotes: [
      "APR is variable and can decline with utilization changes.",
      "Bridge/gas fees reduce net return and should be monitored."
    ],
    executionSteps: [
      `Bridge and allocate ${input.amountUsdc.toFixed(2)} USDC to ${protocol}.`,
      "Monitor APR and liquidity daily for sharp changes.",
      input.riskProfile === "low"
        ? "Compound accrued USDC monthly for lower operational risk."
        : "Compound accrued USDC bi-weekly to target higher effective APY."
    ],
    compoundedProjections: buildCompoundedProjections(input.amountUsdc, apr)
  };
}

function buildCanonicalSummary(
  input: GenerateStrategyInput,
  apr: number
): Pick<StrategyNarrative, "headline" | "recommendation" | "expectedMonthlyUsdc" | "expectedAnnualUsdc"> {
  const protocol = input.decision.selectedOpportunity?.protocol || "selected strategy route";
  const chain = input.decision.selectedOpportunity?.chain || "Kite";
  const monthly = (input.amountUsdc * (apr / 100)) / 12;
  const annual = input.amountUsdc * (apr / 100);
  return {
    headline: `Optimal ${input.riskProfile === "low" ? "Low-Risk" : "Balanced"} Strategy for ${input.amountUsdc.toFixed(2)} USDC`,
    recommendation: `Allocate ${input.amountUsdc.toFixed(2)} USDC to ${protocol} on ${chain} at ${apr.toFixed(
      2
    )}% APR for projected yield of ${monthly.toFixed(2)} USDC per month.`,
    expectedMonthlyUsdc: monthly,
    expectedAnnualUsdc: annual
  };
}

export async function generateStrategyNarrative(input: GenerateStrategyInput): Promise<StrategyNarrative> {
  const apiKey = process.env.GROQ_API_KEY;
  const model = process.env.GROQ_MODEL || "qwen/qwen3-32b";
  if (!apiKey) return buildFallbackNarrative(input);

  const bestOpp = input.decision.selectedOpportunity;
  const context = {
    amountUsdc: input.amountUsdc,
    riskProfile: input.riskProfile,
    selectedOpportunity: bestOpp,
    topOpportunities: input.opportunities.slice(0, 5).map((opp) => ({
      chain: opp.chain,
      protocol: opp.protocol,
      apr: opp.apr,
      risk: opp.risk,
      liquidity: opp.liquidity
    }))
  };

  const prompt = [
    "You are a senior DeFi strategist.",
    "Return valid JSON only with this exact schema keys:",
    "{ headline:string, recommendation:string, expectedMonthlyUsdc:number, expectedAnnualUsdc:number, apr:number, reinvestCadence:string, riskNotes:string[], executionSteps:string[] }",
    "Constraints:",
    "- recommendation must directly mention protocol name and APR percentage.",
    "- executionSteps must have exactly 3 concise actionable steps.",
    "- riskNotes must have 2 concise points.",
    "- Keep it realistic and avoid guaranteed returns.",
    "",
    `Context: ${JSON.stringify(context)}`
  ].join("\n");

  try {
    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model,
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You output strict JSON only. No markdown, no prose outside JSON. Numbers must be numeric values."
          },
          { role: "user", content: prompt }
        ]
      })
    });

    if (!response.ok) return buildFallbackNarrative(input);
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) return buildFallbackNarrative(input);
    const parsed = JSON.parse(sanitizeJsonCandidate(content)) as Partial<StrategyNarrative>;
    if (
      typeof parsed.headline !== "string" ||
      typeof parsed.recommendation !== "string" ||
      typeof parsed.expectedMonthlyUsdc !== "number" ||
      typeof parsed.expectedAnnualUsdc !== "number" ||
      typeof parsed.apr !== "number" ||
      typeof parsed.reinvestCadence !== "string" ||
      !Array.isArray(parsed.riskNotes) ||
      !Array.isArray(parsed.executionSteps)
    ) {
      return buildFallbackNarrative(input);
    }
    const finalApr = input.decision.selectedOpportunity?.apr ?? parsed.apr;
    const canonical = buildCanonicalSummary(input, finalApr);
    return {
      headline: canonical.headline,
      recommendation: canonical.recommendation,
      expectedMonthlyUsdc: canonical.expectedMonthlyUsdc,
      expectedAnnualUsdc: canonical.expectedAnnualUsdc,
      apr: finalApr,
      reinvestCadence: parsed.reinvestCadence,
      riskNotes: parsed.riskNotes.map((item) => String(item)).slice(0, 2),
      executionSteps: parsed.executionSteps.map((item) => String(item)).slice(0, 3),
      compoundedProjections: buildCompoundedProjections(input.amountUsdc, finalApr)
    };
  } catch {
    return buildFallbackNarrative(input);
  }
}
