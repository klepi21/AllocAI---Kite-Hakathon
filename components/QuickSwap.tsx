"use client";

import React, { useState, useEffect } from 'react';
import { ethers } from 'ethers';
import { toast } from 'sonner';

const ArrowDownUp = () => (
  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m3 16 4 4 4-4"/><path d="M7 20V4"/><path d="m21 8-4-4-4 4"/><path d="M17 4v16"/></svg>
);

const Zap = ({ className }: { className?: string }) => (
  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className}><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/></svg>
);

const ROUTER_ADDRESS = "0x03f8b4b140249dc7b2503c928e7258cce1d91f1a";
const WKITE_ADDRESS = "0xcc788DC0486CD2BaacFf287eea1902cc09FbA570";
const USDC_ADDRESS = "0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e";

const ROUTER_ABI = [
  {
    "inputs": [
      {
        "components": [
          { "internalType": "address", "name": "tokenIn", "type": "address" },
          { "internalType": "address", "name": "tokenOut", "type": "address" },
          { "internalType": "address", "name": "deployer", "type": "address" },
          { "internalType": "address", "name": "recipient", "type": "address" },
          { "internalType": "uint256", "name": "deadline", "type": "uint256" },
          { "internalType": "uint256", "name": "amountIn", "type": "uint256" },
          { "internalType": "uint256", "name": "amountOutMinimum", "type": "uint256" },
          { "internalType": "uint160", "name": "limitSqrtPrice", "type": "uint160" }
        ],
        "internalType": "struct ISwapRouter.ExactInputSingleParams",
        "name": "params",
        "type": "tuple"
      }
    ],
    "name": "exactInputSingle",
    "outputs": [{ "internalType": "uint256", "name": "amountOut", "type": "uint256" }],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [
      { "internalType": "uint256", "name": "amountMinimum", "type": "uint256" },
      { "internalType": "address", "name": "recipient", "type": "address" }
    ],
    "name": "unwrapWNativeToken",
    "outputs": [],
    "stateMutability": "payable",
    "type": "function"
  },
  {
    "inputs": [{ "internalType": "bytes[]", "name": "data", "type": "bytes[]" }],
    "name": "multicall",
    "outputs": [{ "internalType": "bytes[]", "name": "results", "type": "bytes[]" }],
    "stateMutability": "payable",
    "type": "function"
  }
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)"
];

interface QuickSwapProps {
  signer: any;
  address: string;
}

export default function QuickSwap({ signer, address }: QuickSwapProps) {
  const TOKENS = [
    { symbol: "KITE", address: "NATIVE", decimals: 18 },
    { symbol: "WKITE", address: WKITE_ADDRESS, decimals: 18 },
    { symbol: "USDC", address: USDC_ADDRESS, decimals: 6 }
  ];

  const [fromToken, setFromToken] = useState(TOKENS[0]);
  const [toToken, setToToken] = useState(TOKENS[2]);
  const [amountIn, setAmountIn] = useState("");
  const [amountOut, setAmountOut] = useState("0.00");
  const [fromBalance, setFromBalance] = useState("--");
  const [loading, setLoading] = useState(false);
  const [swapping, setSwapping] = useState(false);
  const [showFromSelect, setShowFromSelect] = useState(false);
  const [showToSelect, setShowToSelect] = useState(false);
  const [gaslessEnabled, setGaslessEnabled] = useState(true);

  const signTransferAuthorization = async (amount: bigint) => {
    if (!signer || !address) return;
    
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const validAfter = 0;
    const validBefore = Math.floor(Date.now() / 1000) + 3600;

    const domain = {
        name: "USD Coin",
        version: "2",
        chainId: 2366,
        verifyingContract: USDC_ADDRESS
    };

    const types = {
        ReceiveWithAuthorization: [
            { name: "from", type: "address" },
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "validAfter", type: "uint256" },
            { name: "validBefore", type: "uint256" },
            { name: "nonce", type: "bytes32" }
        ]
    };

    const value = {
        from: address,
        to: "0xE5f3e81f3045865EB140fCC44038433891D0e25f", // Relaying Agent
        value: amount,
        validAfter,
        validBefore,
        nonce
    };

    const signature = await (signer as any).signTypedData(domain, types, value);
    const { v, r, s } = ethers.Signature.from(signature);

    return { validAfter, validBefore, nonce, v, r, s };
  };

  const flipTokens = () => {
    const oldFrom = fromToken;
    const oldTo = toToken;
    setFromToken(oldTo);
    setToToken(oldFrom);
    setAmountIn("");
  };

  useEffect(() => {
    const fetchBalance = async () => {
      if (!address || !fromToken) return;
      try {
        const provider = new ethers.JsonRpcProvider("https://rpc.gokite.ai/");
        if (fromToken.address === "NATIVE") {
          const bal = await provider.getBalance(address);
          setFromBalance(Number(ethers.formatEther(bal)).toFixed(4));
        } else {
          const contract = new ethers.Contract(fromToken.address, ERC20_ABI, provider);
          const bal = await contract.balanceOf(address);
          setFromBalance(Number(ethers.formatUnits(bal, fromToken.decimals)).toFixed(4));
        }
      } catch (err) {
        console.error("Balance fetch error:", err);
      }
    };

    fetchBalance();
    const interval = setInterval(fetchBalance, 10000);
    return () => clearInterval(interval);
  }, [address, fromToken]);

  useEffect(() => {
    if (!amountIn || isNaN(Number(amountIn))) {
      setAmountOut("0.00");
      return;
    }
    // Mock price discovery for 1:1 roughly
    const val = Number(amountIn) * (fromToken.symbol === "USDC" ? 2.38 : fromToken.symbol === "KITE" ? 0.42 : 0.42);
    setAmountOut(val.toFixed(6));
  }, [amountIn, fromToken]);

  const executeSwap = async () => {
    if (!signer || !amountIn) return;
    setSwapping(true);
    const swapToast = toast.loading("EXECUTING SWAP...", { description: `Converting ${amountIn} ${fromToken.symbol} to ${toToken.symbol}` });

    try {
      const amountInWei = ethers.parseUnits(amountIn, fromToken.decimals);
      
      // GASLESS USDC -> KITE PATH
      if (gaslessEnabled && fromToken.symbol === "USDC") {
        const auth = await signTransferAuthorization(amountInWei);
        if (!auth) throw new Error("Signature cancelled");

        const response = await fetch("/api/gasless", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                action: "swap",
                params: {
                   from: address,
                   amount: amountInWei.toString(),
                   auth
                }
            })
        });
        
        const result = await response.json();
        if (result.error) throw new Error(result.details?.message || result.error);
        
        toast.success("GASLESS SWAP SUCCESSFUL", { description: "KITE delivered to your wallet." });
        setAmountIn("");
        return;
      }

      // STANDARD PATH (Fallback)
      const deadline = Math.floor(Date.now() / 1000) + 60 * 20;
      if (fromToken.symbol === "KITE" && toToken.symbol === "WKITE") {
        const wkite = new ethers.Contract(WKITE_ADDRESS, ["function deposit() payable"], signer);
        const tx = await wkite.deposit({ value: amountInWei });
        await tx.wait();
        toast.success("WRAP SUCCESSFUL");
        setAmountIn("");
        return;
      }

      if (fromToken.address !== "NATIVE") {
        const tokenContract = new ethers.Contract(fromToken.address, ERC20_ABI, signer);
        const allowance = await tokenContract.allowance(address, ROUTER_ADDRESS);
        if (allowance < amountInWei) {
          const appTx = await tokenContract.approve(ROUTER_ADDRESS, ethers.MaxUint256);
          await appTx.wait();
        }
      }

      const iface = new ethers.Interface(ROUTER_ABI);
      const calls = [];
      const params = {
        tokenIn: fromToken.address === "NATIVE" ? WKITE_ADDRESS : fromToken.address,
        tokenOut: toToken.address === "NATIVE" ? WKITE_ADDRESS : toToken.address,
        deployer: "0x0000000000000000000000000000000000000000",
        recipient: toToken.address === "NATIVE" ? ROUTER_ADDRESS : address,
        deadline: deadline,
        amountIn: amountInWei,
        amountOutMinimum: 0,
        limitSqrtPrice: 0
      };
      calls.push(iface.encodeFunctionData("exactInputSingle", [params]));
      if (toToken.address === "NATIVE") calls.push(iface.encodeFunctionData("unwrapWNativeToken", [0, address]));

      const router = new ethers.Contract(ROUTER_ADDRESS, ROUTER_ABI, signer);
      const tx = await router.multicall(calls, { value: fromToken.address === "NATIVE" ? amountInWei : 0, gasLimit: 800000 });
      await tx.wait();
      toast.success("SWAP SUCCESSFUL");
      setAmountIn("");
    } catch (err: any) {
      console.error(err);
      toast.error("SWAP FAILED", { description: err.message });
    } finally {
      setSwapping(false);
      toast.dismiss(swapToast);
    }
  };

  return (
    <div className="glass-card rounded-[2rem] border-white/5 bg-white/[0.01] p-6 h-full flex flex-col">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-[10px] font-black uppercase tracking-[0.3em] text-white/60">Quick Swap</h2>
        <div className="flex items-center gap-4">
           {fromToken.symbol === "USDC" && (
             <button 
               onClick={() => setGaslessEnabled(!gaslessEnabled)}
               className={`flex items-center gap-1.5 px-3 py-1 rounded-full border transition-all ${gaslessEnabled ? 'bg-blue-500/10 border-blue-500/30 text-blue-400' : 'bg-white/5 border-white/10 text-gray-500'}`}
             >
               <Zap className={gaslessEnabled ? 'animate-pulse' : ''} />
               <span className="text-[8px] font-black uppercase tracking-widest">Gasless</span>
             </button>
           )}
           <div className="flex gap-2">
              <span className="text-[8px] font-black text-[#B3A288] uppercase tracking-widest opacity-50 italic">Aggregated</span>
           </div>
        </div>
      </div>

      <div className="space-y-4 flex-1">
        {/* INPUT */}
        <div className="bg-white/5 rounded-2xl p-4 border border-white/5">
          <div className="flex justify-between items-center mb-2">
            <span className="text-[8px] font-black uppercase text-gray-500 tracking-widest">From</span>
            <span className="text-[8px] font-black uppercase text-gray-400">Balance: {fromBalance}</span>
          </div>
          <div className="flex items-center gap-4">
            <input 
              type="number"
              value={amountIn}
              onChange={(e) => setAmountIn(e.target.value)}
              placeholder="0.0"
              className="bg-transparent text-xl font-black text-white focus:outline-none w-full"
            />
            <div className="relative">
              <button 
                onClick={() => setShowFromSelect(!showFromSelect)}
                className="px-3 py-1.5 bg-white/5 rounded-xl border border-white/10 text-[10px] font-black text-white hover:bg-white/10 transition-colors flex items-center gap-2"
              >
                {fromToken.symbol}
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
              </button>
              {showFromSelect && (
                <div className="absolute top-full right-0 mt-2 py-2 bg-[#080808] border border-white/10 rounded-xl shadow-2xl z-20 min-w-[100px]">
                  {TOKENS.map(t => (
                    <button key={t.symbol} onClick={() => { setFromToken(t); setShowFromSelect(false); }} className="w-full px-4 py-2 text-left text-[10px] font-black text-white hover:bg-white/5 capitalize tracking-widest">{t.symbol}</button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* FLIPPER */}
        <div className="flex justify-center -my-6 relative z-10">
          <button 
            onClick={flipTokens}
            className="p-3 rounded-xl bg-[#080808] border border-white/10 text-gray-400 hover:text-[#B3A288] hover:border-[#B3A288]/30 transition-all shadow-xl shadow-black"
          >
            <ArrowDownUp />
          </button>
        </div>

        {/* OUTPUT */}
        <div className="bg-white/5 rounded-2xl p-4 border border-white/5">
          <div className="flex justify-between items-center mb-2">
            <span className="text-[8px] font-black uppercase text-gray-500 tracking-widest">To (Estimated)</span>
          </div>
          <div className="flex items-center gap-4">
            <p className="text-xl font-black text-white/40 w-full">{amountOut}</p>
            <div className="relative">
              <button 
                onClick={() => setShowToSelect(!showToSelect)}
                className="px-3 py-1.5 bg-white/5 rounded-xl border border-white/10 text-[10px] font-black text-white hover:bg-white/10 transition-colors flex items-center gap-2"
              >
                {toToken.symbol}
                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg>
              </button>
              {showToSelect && (
                <div className="absolute top-full right-0 mt-2 py-2 bg-[#080808] border border-white/10 rounded-xl shadow-2xl z-20 min-w-[100px]">
                  {TOKENS.map(t => (
                    <button key={t.symbol} onClick={() => { setToToken(t); setShowToSelect(false); }} className="w-full px-4 py-2 text-left text-[10px] font-black text-white hover:bg-white/5 capitalize tracking-widest">{t.symbol}</button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      <button 
        onClick={executeSwap}
        disabled={swapping || !amountIn || fromToken.symbol === toToken.symbol}
        className="w-full mt-6 py-4 rounded-2xl bg-[#B3A288] text-black text-[10px] font-black uppercase tracking-[0.2em] shadow-xl shadow-[#B3A288]/20 hover:scale-[1.02] active:scale-95 transition-all disabled:opacity-30 disabled:hover:scale-100"
      >
        {swapping ? "Executing..." : fromToken.symbol === toToken.symbol ? "Invalid Pair" : "Execute Swap"}
      </button>
    </div>
  );
}
