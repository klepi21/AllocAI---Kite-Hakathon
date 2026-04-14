"use client";

import React, { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import { toast } from "sonner";

const USDC_ADDRESS = "0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e";
const LUCID_CONTROLLER = "0x92E2391d0836e10b9e5EAB5d56BfC286Fadec25b";
const LZ_ADAPTER = "0x5eF37628d45C80740fb6dB7eD9c0a753b4f85263";

const ERC20_ABI = [
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)"
];

const CONTROLLER_ABI = [
  "function transferTo(address,uint256,bool,uint256,address,bytes) payable"
];

const ADAPTER_ABI = [
  "function quoteMessage(address destination,uint256 chainId,uint128 gasLimit,bytes message,bool includeFee) view returns(uint256)"
];

interface Props {
  signer: ethers.JsonRpcSigner | null;
  address: string;
  onToggleMode?: () => void;
  toggleLabel?: string;
}

export default function LucidBridge({ signer, address, onToggleMode, toggleLabel }: Props) {
  const [amount, setAmount] = useState("");
  const [running, setRunning] = useState(false);
  const [usdcBalance, setUsdcBalance] = useState("0.00");
  const [selectedDestinationChainId, setSelectedDestinationChainId] = useState("43114");
  const [quotedFeeWei, setQuotedFeeWei] = useState<bigint | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [latestSourceTx, setLatestSourceTx] = useState<string | null>(null);
  const [latestDestinationTx, setLatestDestinationTx] = useState<string | null>(null);
  const [latestDeliveryStatus, setLatestDeliveryStatus] = useState<string | null>(null);

  const destinations = useMemo(
    () => [
      { name: "Avalanche", chainId: "43114", logo: "https://icons.llama.fi/avalanche.png", eta: "~3-5 min" },
      {
        name: "Arbitrum",
        chainId: "42161",
        logo: "https://arbitrum.io/_next/image?url=%2Fbrandkit%2F1225_Arbitrum_Logomark_OneColorNavy_ClearSpace.png&w=640&q=75",
        eta: "~3-4 min"
      },
      { name: "Optimism", chainId: "10", logo: "https://icons.llama.fi/optimism.jpg", eta: "~3-4 min" },
      { name: "Base", chainId: "8453", logo: "https://images.cryptorank.io/coins/base1682407673437.png", eta: "~3-4 min" },
      {
        name: "BSC",
        chainId: "56",
        logo: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1c/BNB%2C_native_cryptocurrency_for_the_Binance_Smart_Chain.svg/330px-BNB%2C_native_cryptocurrency_for_the_Binance_Smart_Chain.svg.png",
        eta: "~4-6 min"
      },
      {
        name: "Celo",
        chainId: "42220",
        logo: "https://static.vecteezy.com/system/resources/previews/024/092/749/non_2x/celo-glass-crypto-coin-3d-illustration-free-png.png",
        eta: "~4-6 min"
      }
    ],
    []
  );

  const destination = useMemo(
    () => destinations.find((item) => item.chainId === selectedDestinationChainId) || destinations[0],
    [destinations, selectedDestinationChainId]
  );
  const sourceExplorerUrl = latestSourceTx ? `https://kitescan.ai/tx/${latestSourceTx}` : null;
  const destinationExplorerBase =
    destination.chainId === "43114" ? "https://snowtrace.io/tx/" : "https://layerzeroscan.com/tx/";
  const destinationExplorerUrl = latestDestinationTx ? `${destinationExplorerBase}${latestDestinationTx}` : null;

  useEffect(() => {
    const loadBalance = async () => {
      if (!signer || !address) {
        setUsdcBalance("0.00");
        return;
      }
      try {
        const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, signer);
        const rawBalance = (await usdc.balanceOf(address)) as bigint;
        setUsdcBalance(Number(ethers.formatUnits(rawBalance, 6)).toFixed(4));
      } catch {
        setUsdcBalance("0.00");
      }
    };
    loadBalance();
  }, [signer, address]);

  const amountNumber = Number(amount || "0");
  const balanceNumber = Number(usdcBalance || "0");
  const insufficientBalance = Number.isFinite(amountNumber) && amountNumber > balanceNumber && amountNumber > 0;
  const sanitizedAmount = Number.isFinite(amountNumber) && amountNumber > 0 ? amountNumber : 0;
  const estimatedReceive = sanitizedAmount;
  const feeKite = quotedFeeWei ? Number(ethers.formatEther(quotedFeeWei)) : 0;
  const feeUsd = feeKite * 0.13;

  useEffect(() => {
    const loadQuote = async () => {
      if (!signer || !address || sanitizedAmount <= 0) {
        setQuotedFeeWei(null);
        return;
      }
      setQuoteLoading(true);
      try {
        const adapter = new ethers.Contract(LZ_ADAPTER, ADAPTER_ABI, signer);
        const amountWei = ethers.parseUnits(sanitizedAmount.toString(), 6);
        const gasLimit = 500000n;
        const message = ethers.AbiCoder.defaultAbiCoder().encode(
          ["tuple(address recipient,uint256 amount,bool unwrap,uint256 threshold,bytes32 transferId)"],
          [[address, amountWei, false, 1n, ethers.ZeroHash]]
        );
        const fee = (await adapter.quoteMessage(
          LUCID_CONTROLLER,
          BigInt(selectedDestinationChainId),
          gasLimit,
          message,
          true
        )) as bigint;
        setQuotedFeeWei(fee);
      } catch {
        setQuotedFeeWei(null);
      } finally {
        setQuoteLoading(false);
      }
    };
    loadQuote();
  }, [signer, address, sanitizedAmount, selectedDestinationChainId]);

  const bridgeNow = async () => {
    if (!signer || !address || !amount || insufficientBalance) return;
    setRunning(true);
    const bridgeToast = toast.loading("BRIDGING USDC", {
      description: `Preparing ${amount} USDC to ${destination.name}...`
    });
    try {
      const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, signer);
      const controller = new ethers.Contract(LUCID_CONTROLLER, CONTROLLER_ABI, signer);
      const adapter = new ethers.Contract(LZ_ADAPTER, ADAPTER_ABI, signer);

      const amountWei = ethers.parseUnits(amount, 6);
      const allowance = await usdc.allowance(address, LUCID_CONTROLLER);
      if (allowance < amountWei) {
        const approveTx = await usdc.approve(LUCID_CONTROLLER, ethers.MaxUint256);
        await approveTx.wait();
      }

      const gasLimit = 500000n;
      const options = ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint128"], [address, gasLimit]);
      const message = ethers.AbiCoder.defaultAbiCoder().encode(
        ["tuple(address recipient,uint256 amount,bool unwrap,uint256 threshold,bytes32 transferId)"],
        [[address, amountWei, false, 1n, ethers.ZeroHash]]
      );
      const quotedFee = await adapter.quoteMessage(
        LUCID_CONTROLLER,
        BigInt(destination.chainId),
        gasLimit,
        message,
        true
      );
      const feeWithBuffer = (quotedFee * 12n) / 10n;

      const tx = await controller.transferTo(address, amountWei, false, BigInt(destination.chainId), LZ_ADAPTER, options, {
        value: feeWithBuffer,
        gasLimit: 900000
      });
      await tx.wait();
      setLatestSourceTx(tx.hash);
      setLatestDestinationTx(null);
      setLatestDeliveryStatus("PENDING");
      try {
        const lz = await fetch(`https://api-mainnet.layerzero-scan.com/tx/${tx.hash}`, {
          cache: "no-store"
        });
        if (lz.ok) {
          const payload = (await lz.json()) as {
            messages?: Array<{ dstTxHash?: string; status?: string }>;
          };
          const message = payload.messages?.[0];
          if (message?.dstTxHash) setLatestDestinationTx(message.dstTxHash);
          if (message?.status) setLatestDeliveryStatus(message.status);
        }
      } catch {
        // Keep source tx link visible even if destination lookup fails.
      }
      toast.dismiss(bridgeToast);
      toast.success("BRIDGE SENT", { description: `Tx ${tx.hash.slice(0, 12)}...` });
      setAmount("");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown bridge error";
      toast.dismiss(bridgeToast);
      toast.error("BRIDGE FAILED", { description: message });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="glass-card rounded-[2rem] border-white/5 bg-[#151515] p-4 h-full flex flex-col">
      <div className="flex items-center gap-3 mb-4">
        <h2 className="text-[10px] font-black uppercase tracking-[0.3em] text-white/60">Lucid Bridge</h2>
        {onToggleMode && toggleLabel && (
          <button
            type="button"
            onClick={onToggleMode}
            className="text-[8px] font-black uppercase tracking-widest text-[#B3A288] hover:text-white transition-colors"
          >
            {toggleLabel}
          </button>
        )}
      </div>
      <div className="space-y-3 flex-1">
        <div className="bg-[#080808] rounded-2xl p-3 border border-white/10">
          <label className="text-[8px] font-black uppercase text-gray-500 tracking-widest mb-2 block">
            Destination Chain
          </label>
          <div className="grid grid-cols-2 gap-2">
            {destinations.map((item) => {
              const active = item.chainId === selectedDestinationChainId;
              return (
                <button
                  key={item.chainId}
                  type="button"
                  onClick={() => setSelectedDestinationChainId(item.chainId)}
                  className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border transition-all ${
                    active
                      ? "bg-[#1d1d1d] border-[#B3A288]/50 text-[#B3A288]"
                      : "bg-[#101010] border-white/10 text-gray-400 hover:border-white/20"
                  }`}
                >
                  <img
                    src={item.logo}
                    alt={item.name}
                    className={`w-4 h-4 rounded-full ${item.name === "Arbitrum" ? "bg-white/90 p-[1px] shadow-[0_0_10px_rgba(255,255,255,0.65)]" : ""}`}
                  />
                  <span className="text-[9px] font-black uppercase tracking-wider">{item.name}</span>
                </button>
              );
            })}
          </div>
        </div>
        <div className="bg-[#080808] rounded-2xl p-3 border border-white/10">
          <div className="flex items-center justify-between mb-2">
            <label className="text-[8px] font-black uppercase text-gray-500 tracking-widest">
              Amount to Bridge (USDC)
            </label>
            <button
              type="button"
              onClick={() => setAmount(usdcBalance)}
              className="text-[8px] font-black uppercase tracking-widest text-blue-300"
            >
              Max
            </button>
          </div>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="w-full bg-[#080808] border border-white/10 rounded-xl px-3 py-2.5 text-base font-bold text-white focus:outline-none focus:border-[#B3A288]/40 placeholder:text-[9px] placeholder:text-gray-500"
            placeholder="USDC amount"
          />
          <p className="text-[8px] font-black uppercase tracking-widest text-gray-400 mt-2">
            Wallet USDC Balance: {usdcBalance}
          </p>
          {insufficientBalance && (
            <p className="text-[8px] font-black uppercase tracking-widest text-red-300 mt-1">
              Amount exceeds your USDC wallet balance.
            </p>
          )}
        </div>
        <div className="bg-[#080808] rounded-2xl p-3 border border-white/10 space-y-2.5">
          <div className="flex items-center justify-between">
            <span className="text-[8px] font-black uppercase tracking-widest text-gray-500">You Send</span>
            <span className="text-[10px] font-black uppercase text-white">
              {sanitizedAmount > 0 ? sanitizedAmount.toFixed(4) : "0.0000"} USDC
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[8px] font-black uppercase tracking-widest text-gray-500">You Receive (Est.)</span>
            <span className="text-[10px] font-black uppercase text-[#B3A288]">
              {estimatedReceive > 0 ? estimatedReceive.toFixed(4) : "0.0000"} USDC
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[8px] font-black uppercase tracking-widest text-gray-500">Relayer Fee</span>
            <span className="text-[10px] font-black uppercase text-white">
              {quoteLoading ? "Quoting..." : quotedFeeWei ? `${feeKite.toFixed(4)} KITE` : "N/A"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[8px] font-black uppercase tracking-widest text-gray-500">Fee (USD Est.)</span>
            <span className="text-[10px] font-black uppercase text-white">
              {quoteLoading ? "..." : quotedFeeWei ? `~$${feeUsd.toFixed(2)}` : "N/A"}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[8px] font-black uppercase tracking-widest text-gray-500">Estimated Time</span>
            <span className="text-[10px] font-black uppercase text-white">{destination.eta}</span>
          </div>
          <div className="pt-1 border-t border-white/10">
            <p className="text-[8px] font-black uppercase tracking-widest text-gray-500">Route</p>
            <p className="text-[9px] font-black text-gray-300 mt-1">
              Kite USDC → LayerZero/Lucid → {destination.name} USDC
            </p>
          </div>
        </div>
        <div className="bg-[#080808] rounded-2xl p-3 border border-white/10 space-y-2">
          <p className="text-[8px] font-black uppercase tracking-widest text-[#B3A288]">
            After You Click Bridge
          </p>
          <p className="text-[9px] font-black text-gray-300 leading-relaxed">
            Cross-chain delivery is not instant. It usually arrives in your destination wallet within a few minutes.
          </p>
          {sourceExplorerUrl ? (
            <a
              href={sourceExplorerUrl}
              target="_blank"
              rel="noreferrer"
              className="block text-[9px] font-black text-blue-300 hover:text-blue-200 break-all"
            >
              Source Tx (Kitescan): {latestSourceTx}
            </a>
          ) : (
            <p className="text-[8px] font-black uppercase tracking-widest text-gray-500">
              Source tx link appears here after submit.
            </p>
          )}
          {destinationExplorerUrl ? (
            <a
              href={destinationExplorerUrl}
              target="_blank"
              rel="noreferrer"
              className="block text-[9px] font-black text-emerald-300 hover:text-emerald-200 break-all"
            >
              Destination Tx: {latestDestinationTx}
            </a>
          ) : (
            <p className="text-[8px] font-black uppercase tracking-widest text-gray-500">
              Destination tx may appear after relayer confirmation.
            </p>
          )}
          <p className="text-[8px] font-black uppercase tracking-widest text-gray-500">
            Delivery Status: {latestDeliveryStatus || "N/A"} · If funds do not appear, switch wallet to {destination.name} and add USDC token.
          </p>
        </div>
      </div>
      <button
        onClick={bridgeNow}
        disabled={running || !amount || !address || insufficientBalance}
        className="w-full mt-4 py-3 rounded-2xl bg-blue-500/20 text-blue-200 text-[10px] font-black uppercase tracking-[0.2em] border border-blue-500/20 disabled:opacity-40"
      >
        {running ? "Bridging..." : "Bridge USDC"}
      </button>
    </div>
  );
}
