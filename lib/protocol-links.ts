function normalize(value: string): string {
  return value.toLowerCase().trim();
}

export function getProtocolStrategyUrl(protocol: string, chain: string): string | null {
  const p = normalize(protocol);
  const c = normalize(chain);
  const context = `${p} ${c}`;

  if (p.includes("aave")) {
    const chainParam = c.includes("arbitrum")
      ? "arbitrum"
      : c.includes("base")
        ? "base"
        : c.includes("optimism")
          ? "optimism"
          : c.includes("avalanche")
            ? "avalanche"
            : c.includes("ethereum")
              ? "ethereum"
              : "ethereum";
    return `https://app.aave.com/?marketName=proto_${chainParam}_v3`;
  }

  if (p.includes("compound")) return "https://app.compound.finance/";
  if (p.includes("gmx")) return "https://app.gmx.io/";
  if (p.includes("morpho")) {
    const isOptimismContext = context.includes("optimism") || context.includes("op mainnet") || context.includes("opmainnet");
    const isUsdcContext = context.includes("usdc");
    // Prefer a specific Morpho Optimism USDC vault when context strongly indicates this route.
    if (isOptimismContext && isUsdcContext) {
      return "https://app.morpho.org/opmainnet/vault/0x4fFc4e5F1f1F5C43dc9Bc27b53728DA13b02bE35/gauntlet-usdc-balanced";
    }
    return "https://app.morpho.org/";
  }
  if (p.includes("aerodrome")) return "https://aerodrome.finance/";
  if (p.includes("stargate")) return "https://stargate.finance/";
  if (p.includes("curve")) return "https://curve.fi/";
  if (p.includes("uniswap")) return "https://app.uniswap.org/";

  // Do not route protocol CTA to DeFiLlama fallback.
  // If protocol mapping is unknown, hide protocol CTA instead.
  return null;
}
