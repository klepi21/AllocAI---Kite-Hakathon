import { NextResponse } from 'next/server';
import { ethers } from 'ethers';

const RPC_URL = process.env.NEXT_PUBLIC_KITE_RPC || "https://rpc.gokite.ai/";
const AGENT_KEY = process.env.AGENT_PRIVATE_KEY;
const ROUTER_ADDRESS = "0x03f8b4b140249dc7b2503c928e7258cce1d91f1a";
const USDC_ADDRESS = "0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e";
const WKITE_ADDRESS = "0xcc788DC0486CD2BaacFf287eea1902cc09FbA570";

export async function POST(req: Request) {
  try {
    const payload = await req.json();
    const { action, params } = payload;

    // --- CASE 1: KITE NATIVE GASLESS (USDC transfer via gasless.gokite.ai) ---
    // Kite's own relayer pays the gas. User only signs EIP-712.
    if (action === "kite_gasless") {
      console.log(`⚡ Kite Gasless Relay: ${params.from} → ${params.to} (${params.value} USDC)`);

      const kitePayload = {
        from: params.from,
        to: params.to,
        value: params.value,
        tokenAddress: params.tokenAddress,
        validAfter: params.validAfter,
        validBefore: params.validBefore,
        nonce: params.nonce,
        v: params.v,
        r: params.r,
        s: params.s,
      };

      const response = await fetch("https://gasless.gokite.ai/mainnet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(kitePayload)
      });

      const textData = await response.text();
      let data: any;
      try { data = JSON.parse(textData); } catch { data = { message: textData }; }

      if (!response.ok) {
        console.error("Kite Gasless rejected:", response.status, data);
        return NextResponse.json({ error: "Kite Gasless API Error", details: data }, { status: response.status });
      }

      return NextResponse.json({ success: true, txHash: data.txHash || data.tx_hash || data.hash });
    }

    if (!AGENT_KEY) throw new Error("Agent key not configured");
    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const agent = new ethers.Wallet(AGENT_KEY, provider);

    // --- CASE 2: GASLESS SWAP (USDC -> KITE via Agent) ---
    if (action === "swap") {
        console.log(`🤖 Agent Relayer: Executing Gasless Swap for ${params.from}`);
        const usdc = new ethers.Contract(USDC_ADDRESS, [
            "function receiveWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32) external"
        ], agent);

        const router = new ethers.Contract(ROUTER_ADDRESS, [
            "function exactInputSingle((address,address,address,address,uint256,uint256,uint256,uint160)) external payable returns (uint256)",
            "function unwrapWNativeToken(uint256,address) external payable",
            "function multicall(bytes[]) external payable"
        ], agent);

        const { validAfter, validBefore, nonce, v, r, s } = params.auth;
        const pullTx = await usdc.receiveWithAuthorization(
            params.from, agent.address, params.amount, validAfter, validBefore, nonce, v, r, s,
            { gasLimit: 300000 }
        );
        await pullTx.wait();

        const deadline = Math.floor(Date.now() / 1000) + 1200;
        const swapParams = {
            tokenIn: USDC_ADDRESS, tokenOut: WKITE_ADDRESS,
            deployer: ethers.ZeroAddress, recipient: ROUTER_ADDRESS,
            deadline, amountIn: params.amount, amountOutMinimum: 0, limitSqrtPrice: 0
        };

        const iface = new ethers.Interface(router.interface.format());
        const calls = [
            iface.encodeFunctionData("exactInputSingle", [swapParams]),
            iface.encodeFunctionData("unwrapWNativeToken", [0, params.from])
        ];

        const approveTx = await new ethers.Contract(USDC_ADDRESS, ["function approve(address,uint256)"], agent).approve(ROUTER_ADDRESS, params.amount);
        await approveTx.wait();

        const tx = await router.multicall(calls, { gasLimit: 800000 });
        const receipt = await tx.wait();
        return NextResponse.json({ success: true, txHash: receipt?.hash });
    }

    // --- CASE 3: AGENT RELAY (arbitrary tx, agent pays gas) ---
    if (action === "relay") {
        console.log(`🤖 Agent Relayer: Submitting tx to ${params.to}`);
        const tx = await agent.sendTransaction({ to: params.to, data: params.data, gasLimit: 600000 });
        const receipt = await tx.wait();
        return NextResponse.json({ success: true, txHash: receipt?.hash });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err: any) {
    console.error("Relayer Error:", err);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
