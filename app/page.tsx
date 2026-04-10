"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import Header from "@/components/Header";
import WalletPanel from "@/components/WalletPanel";
import YieldTable from "@/components/YieldTable";
import DecisionPanel from "@/components/DecisionPanel";
import QuickSwap from "@/components/QuickSwap";
import RunAgentButton from "@/components/RunAgentButton";
import { EtheralShadow } from "@/components/ui/etheral-shadow";
import { useKiteWallet } from "@/hooks/useKiteWallet";
import { CURRENT_NETWORK } from "@/lib/networks";
import { YieldOpportunity, AgentDecision, TimelineEvent } from "@/lib/types";
import { ethers } from "ethers";
import { toast } from "sonner";

const VAULT_ADDRESS = "0x9cCA18327e8B4a11fE8011695E4bb330a48237df";
const USDC_TOKEN = "0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e";
const PROOF_LOG_ADDRESS = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F"; 
const LUCID_CONTROLLER = "0x92E2391d0836e10b9e5EAB5d56BfC286Fadec25b";
const LUCID_TOKEN_KITE = "0x7aB6f3ed87C42eF0aDb67Ed95090f8bF5240149e";

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balance(address account) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)"
];

const VAULT_ABI = [
  "function deposit(uint256 _amount, string memory _sourceChain) external",
  "function depositWithSignature(uint256 _assets, string memory _sourceChain, uint256 _validAfter, uint256 _validBefore, bytes32 _nonce, uint8 _v, bytes32 _r, bytes32 _s) external",
  "function withdraw(uint256 _amount) external",
  "function withdrawWithSignature(uint256 _assets, uint256 _deadline, uint8 _v, bytes32 _r, bytes32 _s) external",
  "function reallocate(string memory _protocol, string memory _chain, uint256 _newApr, bytes32 _proofHash, address _targetContract, bytes memory _executionData, address _newStakingContract, address _newYieldToken) external",
  "function totalAssets() public view returns (uint256)",
  "function totalShares() public view returns (uint256)",
  "function userShares(address) public view returns (uint256)",
  "function USDC_TOKEN() public view returns (address)",
  "function getVaultStatus() public view returns (string, string, uint256)",
  "function pendingWithdrawals(address) public view returns (uint256 assets, uint256 shares, bool isNative)"
];

interface ProofRecord {
  id: string;
  txHash: string;
  timestamp: string;
  action: string;
  protocol: string;
  confidence: number;
  reason: string;
}

export default function Home() {
  const { address, signer, connect, refreshBalance } = useKiteWallet();
  const [opportunities, setOpportunities] = useState<YieldOpportunity[]>([]);
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<"idle" | "scanning" | "purchasing" | "thinking" | "logging">("idle");
  const [decision, setDecision] = useState<AgentDecision | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [proofs, setProofs] = useState<ProofRecord[]>([]);
  const [currentApr, setCurrentApr] = useState(5.85);
  const [activeStrategyLabel, setActiveStrategyLabel] = useState<string>("Lucid Native · Kite AI");
  const [mounted, setMounted] = useState(false);
  const [scanningHistory, setScanningHistory] = useState(false);
  const lastSyncRef = useRef<number>(0);

  // Tab State
  const [activeTab, setActiveTab] = useState<"dashboard" | "operator">("dashboard");
  const [pendingWithdrawal, setPendingWithdrawal] = useState<{assets: string, shares: string} | null>(null);

  // Balances
  const [balance, setBalance] = useState(0.00);
  const [dripBalance, setDripBalance] = useState(0.00);
  const [totalVaultBalance, setTotalVaultBalance] = useState(0.00);
  const [tokenDecimals, setTokenDecimals] = useState(18);
  const [walletUsdc, setWalletUsdc] = useState(0);
  const [gaslessEnabled, setGaslessEnabled] = useState(true);

  // Modals
  const [showModal, setShowModal] = useState(false);
  const [showWithdrawModal, setShowWithdrawModal] = useState(false);
  const [amount, setAmount] = useState("100");
  const [withdrawAmount, setWithdrawAmount] = useState("");

  const addEvent = (message: string, type: TimelineEvent["type"]) => {
    setEvents(prev => [...prev, { id: Math.random().toString(36).substring(2, 11), timestamp: new Date().toISOString(), message, type }]);
  };

  const syncVault = useCallback(async () => {
    if (!signer || !address) return;
    const now = Date.now();
    if (now - lastSyncRef.current < 15000) return;
    lastSyncRef.current = now;

    try {
      const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, signer);
      const usdcAddr = await vault.USDC_TOKEN();
      const token = new ethers.Contract(usdcAddr, ["function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)"], signer);
      
      const decimals = await token.decimals().catch(() => 18);
      setTokenDecimals(Number(decimals));

      const [vaultAssets, totalShares, userShares, walletBal, vaultStatus, userPending] = await Promise.all([
        vault.totalAssets().catch(() => BigInt(0)),
        vault.totalShares().catch(() => BigInt(0)),
        vault.userShares(address).catch(() => BigInt(0)),
        token.balanceOf(address).catch(() => BigInt(0)),
        vault.getVaultStatus().catch(() => null),
        vault.pendingWithdrawals(address).catch(() => null)
      ]);

      // Handle Pending
      if (userPending && userPending.assets > BigInt(0)) {
          setPendingWithdrawal({
              assets: ethers.formatUnits(userPending.assets, Number(decimals)),
              shares: ethers.formatUnits(userPending.shares, Number(decimals)),
          });
      } else {
          setPendingWithdrawal(null);
      }

      // Calculate Real Balance
      let realUserBal = 0n;
      if (BigInt(totalShares) > 0n) {
          realUserBal = (BigInt(userShares) * BigInt(vaultAssets)) / BigInt(totalShares);
      }

      const formattedUser = parseFloat(ethers.formatUnits(realUserBal, Number(decimals)));
      setBalance(formattedUser);
      setDripBalance(formattedUser);
      setTotalVaultBalance(parseFloat(ethers.formatUnits(vaultAssets, Number(decimals))));
      setWalletUsdc(parseFloat(ethers.formatUnits(walletBal, Number(decimals))));

      if (vaultStatus) {
          const [proto, chain, aprBps] = vaultStatus;
          let apr = Number(aprBps) / 100;
          if (proto.toLowerCase().includes("lucid")) {
              try {
                  const lucid = new ethers.Contract(LUCID_CONTROLLER, ["function getMarketState() view returns (uint256,uint256,uint256)"], signer);
                  const [,,realApr] = await lucid.getMarketState();
                  apr = Number(realApr) / 100;
              } catch(e) {}
          }
          setCurrentApr(apr);
          setActiveStrategyLabel(`${proto} · ${chain}`);
      }
      refreshBalance();
    } catch (e) {
      console.error("Sync failed", e);
    }
  }, [signer, address, refreshBalance]);

  useEffect(() => {
    setMounted(true);
    fetch("/api/yield").then(r => r.json()).then(d => setOpportunities(d.opportunities));
  }, []);

  useEffect(() => {
    if (mounted && signer) syncVault();
  }, [mounted, signer, syncVault]);

  const handleManualMove = async (opp: YieldOpportunity) => {
    if (!signer || !address) return;
    const manualToast = toast.loading("OPERATOR OVERRIDE", { description: `Reallocating vault to ${opp.protocol}...` });
    setStatus("logging");

    try {
      const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, signer);
      const aprWei = BigInt(Math.round(opp.apr * 100));
      const proofId = "OPERATOR_" + Date.now().toString(36);
      
      let targetContract = ethers.ZeroAddress;
      let execData = "0x";
      let newStaking = ethers.ZeroAddress;
      let newYield = ethers.ZeroAddress;

      if (opp.protocol.includes("Lucid")) {
         targetContract = LUCID_CONTROLLER;
         const iface = new ethers.Interface(["function deposit(uint256 amount) external"]);
         const assets = await vault.totalAssets();
         execData = iface.encodeFunctionData("deposit", [assets]);
         newStaking = LUCID_CONTROLLER;
         newYield = LUCID_TOKEN_KITE;
      }

      const tx = await vault.reallocate(
        opp.protocol, opp.chain, aprWei, ethers.encodeBytes32String(proofId.slice(0, 31)),
        targetContract, execData, newStaking, newYield
      );

      await tx.wait();
      toast.dismiss(manualToast);
      toast.success("STRATEGY UPDATED", { description: `Vault successfully reallocated to ${opp.protocol} @ ${opp.apr}%` });
      syncVault();
    } catch (err: any) {
      toast.dismiss(manualToast);
      toast.error("OVERRIDE FAILED", { description: err.message });
    } finally {
      setStatus("idle");
    }
  };

  const executeGaslessAction = async (target: string, data: string, desc: string, _val: bigint) => {
    toast.info("RELAYING VIA AGENT", { description: desc });
    try {
      const response = await fetch("/api/gasless", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "relay",
          params: { from: address, to: target, data }
        })
      });
      const result = await response.json();
      if (result.error) throw new Error(result.details?.message || result.error);
      toast.success("RELAY SUCCESSFUL", { description: `Agent submitted: ${result.txHash?.slice(0, 10)}...` });
      return result;
    } catch (err: any) {
      toast.error("RELAY FAILED", { description: err.message });
      throw err;
    }
  };

  const signTransferAuthorization = async (amount: bigint) => {
      if (!signer || !address) return;
      
      const nonce = ethers.hexlify(ethers.randomBytes(32));
      const now = Math.floor(Date.now() / 1000);
      const validAfter = now - 1;           // Must be slightly in the past
      const validBefore = now + 25;         // Kite requires within 30s window

      // Domain from Kite's /supported_tokens response
      const domain = {
          name: "Bridged USDC (Kite AI)",  // exact name from Kite docs
          version: "2",
          chainId: 2366,
          verifyingContract: USDC_TOKEN
      };

      const types = {
          TransferWithAuthorization: [     // Kite uses Transfer not Receive
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
          to: VAULT_ADDRESS,             // USDC goes directly to vault
          value: amount,
          validAfter,
          validBefore,
          nonce
      };

      const signature = await (signer as any).signTypedData(domain, types, value);
      const { v, r, s } = ethers.Signature.from(signature);

      return { from: address, to: VAULT_ADDRESS, validAfter, validBefore, nonce, v, r, s };
  };

  const signWithdrawAuthorization = async (amount: bigint) => {
      if (!signer || !address) return;
      
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      const domain = {
          name: "AllocAIVault",
          version: "1",
          chainId: 2366,
          verifyingContract: VAULT_ADDRESS
      };

      const types = {
          Withdrawal: [
              { name: "user", type: "address" },
              { name: "assets", type: "uint256" },
              { name: "deadline", type: "uint256" }
          ]
      };

      const value = {
          user: address,
          assets: amount,
          deadline
      };

      const signature = await (signer as any).signTypedData(domain, types, value);
      const { v, r, s } = ethers.Signature.from(signature);

      return { deadline, v, r, s };
  };

  const handleConfirmDeposit = async () => {
    if (!signer || !address || !amount) return;
    setShowModal(false);
    
    try {
      const amountWei = ethers.parseUnits(amount, tokenDecimals);

      if (gaslessEnabled) {
        const auth = await signTransferAuthorization(amountWei);
        if (!auth) return;

        // Submit directly to Kite's gasless relay
        // Kite pays gas, USDC moves from user wallet -> vault
        const response = await fetch("/api/gasless", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "kite_gasless",
            params: {
              from: address,
              to: VAULT_ADDRESS,
              value: amountWei.toString(),
              tokenAddress: USDC_TOKEN,
              validAfter: auth.validAfter.toString(),
              validBefore: auth.validBefore.toString(),
              nonce: auth.nonce,
              v: auth.v,
              r: auth.r,
              s: auth.s
            }
          })
        });

        const result = await response.json();
        if (result.error) throw new Error(result.details?.message || result.error);

        toast.success("DEPOSIT RELAYED", { description: `Kite submitted: ${result.txHash?.slice(0, 12)}...` });
      } else {
        const usdc = new ethers.Contract(USDC_TOKEN, ERC20_ABI, signer);
        const approveTx = await usdc.approve(VAULT_ADDRESS, amountWei);
        await approveTx.wait();
        const vault = new ethers.Contract(VAULT_ADDRESS, VAULT_ABI, signer);
        const tx = await vault.deposit(amountWei, "Kite Native");
        await tx.wait();
      }

      toast.success("DEPOSIT COMPLETE", { description: "Capital successfully staked in strategy." });
      syncVault();
    } catch (err: any) {
      console.error(err);
      toast.error("DEPOSIT FAILED", { description: err.message });
    }
  };

  const handleConfirmWithdraw = async () => {
    if (!signer || !address || !withdrawAmount) return;
    setShowWithdrawModal(false);
    
    try {
      const amountWei = ethers.parseUnits(withdrawAmount, tokenDecimals);
      const vaultIface = new ethers.Interface(VAULT_ABI);

      if (gaslessEnabled) {
        const auth = await signWithdrawAuthorization(amountWei);
        if (!auth) return;

        const withdrawData = vaultIface.encodeFunctionData("withdrawWithSignature", [
            amountWei, auth.deadline, auth.v, auth.r, auth.s
        ]);

        await executeGaslessAction(VAULT_ADDRESS, withdrawData, "Gasless Vault Withdrawal", amountWei);
      } else {
        const withdrawData = vaultIface.encodeFunctionData("withdraw", [amountWei]);
        const tx = await signer.sendTransaction({
          to: VAULT_ADDRESS,
          data: withdrawData,
          gasLimit: 500000
        });
        await tx.wait();
      }

      toast.success("WITHDRAWAL INITIATED", { description: "Assets are being liquidated..." });
      syncVault();
    } catch (err: any) {
      console.error(err);
      toast.error("WITHDRAWAL FAILED", { description: err.message });
    }
  };

  if (!mounted) return <div className="min-h-screen bg-[#080808]" />;

  return (
    <main className="min-h-screen bg-[#080808] pb-24 overflow-x-hidden relative">
      <EtheralShadow color="rgba(179, 162, 136, 0.15)" animation={{ scale: 80, speed: 10 }} noise={{ opacity: 0.2, scale: 1.5 }} sizing="fill" />

      {/* DEPOSIT MODAL */}
      {showModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 animate-in fade-in duration-300">
           <div className="absolute inset-0 bg-black/80 backdrop-blur-md" onClick={() => setShowModal(false)} />
           <div className="glass-card p-10 rounded-[3rem] border-[#B3A288]/20 bg-[#0A0A0A] relative z-10 w-full max-w-lg shadow-[0_50px_100px_-20px_rgba(179,162,136,0.3)] border-2">
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-xl font-black uppercase tracking-[0.2em] text-white">Deposit Capital</h3>
                <div className="text-[9px] font-black uppercase text-[#B3A288] bg-[#B3A288]/10 px-3 py-1.5 rounded-full border border-[#B3A288]/20">
                   Wallet: ${walletUsdc.toLocaleString()} USDC
                </div>
              </div>
              <p className="text-[10px] uppercase font-black tracking-widest text-[#B3A288] mb-8 opacity-60">Step 1: Approve • Step 2: Deposit</p>
              
              <div className="mb-8 p-5 rounded-2xl bg-blue-500/5 border border-blue-500/10 flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse"></span>
                        <p className="text-[10px] font-black uppercase text-blue-400 tracking-wider">Kite Gasless Mode</p>
                    </div>
                    <p className="text-[9px] font-medium text-blue-200/60 uppercase">Pay gas in USDC. No KITE needed.</p>
                  </div>
                  <button 
                    onClick={() => setGaslessEnabled(!gaslessEnabled)}
                    className={`w-12 h-6 rounded-full transition-all relative ${gaslessEnabled ? 'bg-blue-500' : 'bg-white/10'}`}
                  >
                    <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${gaslessEnabled ? 'right-1' : 'left-1'}`} />
                  </button>
               </div>
              
              <div className="mb-10">
                 <label className="text-[10px] font-black uppercase text-gray-500 mb-4 block tracking-[0.3em]">Amount (USDC)</label>
                 <div className="relative">
                    <input 
                      type="number" 
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      className="w-full bg-white/5 border-2 border-white/10 rounded-2xl py-6 px-8 text-2xl font-black text-white focus:border-[#B3A288] focus:outline-none transition-all placeholder-white/20"
                      placeholder="0.00"
                    />
                    <div className="absolute right-8 top-1/2 -translate-y-1/2 text-[10px] font-black uppercase text-[#B3A288]">USDC</div>
                 </div>
              </div>

              <div className="flex gap-4">
                 <button 
                   onClick={() => setShowModal(false)}
                   className="flex-1 py-5 rounded-2xl text-[10px] font-black uppercase tracking-widest bg-white/5 text-white hover:bg-white/10 transition-all border border-white/5"
                 >
                    Cancel
                 </button>
                 <button 
                   onClick={handleConfirmDeposit}
                   className="flex-[2] py-5 rounded-2xl text-[10px] font-black uppercase tracking-widest bg-[#B3A288] text-black shadow-2xl shadow-[#B3A288]/40 hover:scale-[1.02] active:scale-95 transition-all"
                 >
                    Confirm & Execute
                 </button>
              </div>
           </div>
        </div>
      )}

      {/* WITHDRAW MODAL */}
      {showWithdrawModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6 animate-in fade-in duration-300">
           <div className="absolute inset-0 bg-black/80 backdrop-blur-md" onClick={() => setShowWithdrawModal(false)} />
           <div className="glass-card p-10 rounded-[3rem] border-red-500/20 bg-[#0A0A0A] relative z-10 w-full max-w-lg shadow-[0_50px_100px_-20px_rgba(239,68,68,0.2)] border-2">
              <div className="flex justify-between items-center mb-6">
                <h3 className="text-xl font-black uppercase tracking-[0.2em] text-white">Withdraw Capital</h3>
                <div className="text-[9px] font-black uppercase text-red-500 bg-red-500/10 px-3 py-1.5 rounded-full border border-red-500/20">
                   Vault Balance: {balance.toLocaleString()} USDC
                </div>
              </div>
              <p className="text-[10px] uppercase font-black tracking-widest text-red-500/60 mb-8">Pulling funds from destination chain</p>
              
              <div className="mb-8 p-5 rounded-2xl bg-blue-500/5 border border-blue-500/10 flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse"></span>
                        <p className="text-[10px] font-black uppercase text-blue-400 tracking-wider">Kite Gasless Mode</p>
                    </div>
                    <p className="text-[9px] font-medium text-blue-200/60 uppercase">Pay gas in USDC. No KITE needed.</p>
                  </div>
                  <button 
                    onClick={() => setGaslessEnabled(!gaslessEnabled)}
                    className={`w-12 h-6 rounded-full transition-all relative ${gaslessEnabled ? 'bg-blue-500' : 'bg-white/10'}`}
                  >
                    <div className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${gaslessEnabled ? 'right-1' : 'left-1'}`} />
                  </button>
               </div>
              
              <div className="mb-10">
                 <label className="text-[10px] font-black uppercase text-gray-500 mb-4 block tracking-[0.3em]">Amount (USDC)</label>
                 <div className="relative">
                    <input 
                      type="number" 
                      value={withdrawAmount}
                      onChange={(e) => setWithdrawAmount(e.target.value)}
                      className="w-full bg-white/5 border-2 border-white/10 rounded-2xl py-6 px-8 text-2xl font-black text-white focus:border-red-500 focus:outline-none transition-all placeholder-white/20"
                      placeholder="0.00"
                    />
                    <div className="absolute right-8 top-1/2 -translate-y-1/2 text-[10px] font-black uppercase text-red-500/60">USDC</div>
                 </div>
              </div>

              <div className="flex gap-4">
                 <button 
                   onClick={() => setShowWithdrawModal(false)}
                   className="flex-1 py-5 rounded-2xl text-[10px] font-black uppercase tracking-widest bg-white/5 text-white hover:bg-white/10 transition-all border border-white/5"
                 >
                    Cancel
                 </button>
                 <button 
                   onClick={handleConfirmWithdraw}
                   className="flex-[2] py-5 rounded-2xl text-[10px] font-black uppercase tracking-widest bg-red-500 text-white shadow-2xl shadow-red-500/40 hover:scale-[1.02] active:scale-95 transition-all"
                 >
                    Confirm Withdraw
                 </button>
              </div>
           </div>
        </div>
      )}

      <div className="relative z-10 container mx-auto px-6 pt-12 max-w-7xl">
        <div className="flex flex-col lg:flex-row items-end lg:items-center justify-between mb-12 px-2 gap-8">
            <Header />
            <div className="flex flex-col sm:flex-row items-center gap-4">
               <div className="bg-white/5 p-1.5 rounded-2xl flex gap-1 border border-white/10">
                  <button onClick={() => setActiveTab("dashboard")} className={`px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'dashboard' ? 'bg-[#B3A288] text-black' : 'text-gray-500 hover:text-white'}`}>Autonomous</button>
                  <button onClick={() => setActiveTab("operator")} className={`px-6 py-2.5 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'operator' ? 'bg-[#B3A288] text-black' : 'text-gray-500 hover:text-white'}`}>Operator</button>
               </div>
               <WalletPanel />
            </div>
        </div>

        {pendingWithdrawal && (
            <div className="mb-8 p-6 rounded-[2rem] bg-amber-500/10 border border-amber-500/20 flex items-center justify-between animate-pulse">
                <div className="flex items-center gap-4">
                    <span className="text-xl">⏳</span>
                    <div>
                        <h4 className="text-[11px] font-black uppercase tracking-widest text-amber-200">Bridge Settlement In-Progress</h4>
                        <p className="text-[9px] font-bold text-amber-500/70 uppercase">Escrowed: {pendingWithdrawal.assets} USDC · Arriving from remote chain</p>
                    </div>
                </div>
                <div className="text-[8px] font-black uppercase text-amber-500 px-4 py-2 bg-amber-500/10 rounded-xl">In Space-Time Bridge</div>
            </div>
        )}

        {activeTab === "dashboard" ? (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6 mb-12">
               {[
                   { title: "My Position", value: `$${dripBalance.toLocaleString(undefined, { minimumFractionDigits: 4 })}`, icon: "👤", desc: "Principal + Yield" },
                   { title: "Protocol TVL", value: `$${totalVaultBalance.toLocaleString()}`, icon: "💎", highlight: true, desc: "Global Assets" },
                   { title: "Real-time APR", value: `${currentApr.toFixed(2)}%`, icon: "📈", desc: "Active Rate" }
               ].map((stat, i) => (
                   <div key={i} className={`glass-card p-8 rounded-[2.5rem] border-white/10 flex flex-col justify-between relative overflow-hidden transition-all ${stat.highlight ? 'bg-gradient-to-br from-white/[0.03] to-transparent' : ''}`}>
                      <div>
                        <span className="text-[9px] font-black text-gray-500 uppercase tracking-widest mb-4 flex items-center">
                            <span className="mr-3 text-lg">{stat.icon}</span>{stat.title}
                        </span>
                        <h3 className={`text-2xl font-black tabular-nums font-mono ${stat.highlight ? 'text-[#B3A288]' : 'text-white'}`}>{stat.value}</h3>
                        <p className="text-[8px] font-black text-white/20 uppercase mt-1">{stat.desc}</p>
                      </div>
                      {stat.title === "My Position" && (
                          <div className="mt-8 flex gap-3">
                              {balance > 0 && <button onClick={() => setShowWithdrawModal(true)} className="flex-1 py-4 bg-white/5 border border-white/10 rounded-2xl text-[8px] font-black uppercase text-gray-400">Withdraw</button>}
                              <button onClick={() => setShowModal(true)} className="flex-1 py-4 bg-[#B3A288] text-black rounded-2xl text-[8px] font-black uppercase shadow-lg shadow-[#B3A288]/20">Deposit</button>
                          </div>
                      )}
                      {stat.title === "Real-time APR" && (
                          <div className="mt-8 p-4 rounded-2xl bg-emerald-500/5 border border-emerald-500/10 flex items-center gap-3">
                              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                              <span className="text-[9px] font-black text-emerald-400 uppercase tracking-tight truncate">{activeStrategyLabel}</span>
                          </div>
                      )}
                   </div>
               ))}
            </div>

            <div className="grid grid-cols-1 xl:grid-cols-12 gap-8 mb-8 items-stretch">
               <div className="xl:col-span-8">
                  <div className="glass-card rounded-[2rem] overflow-hidden h-full">
                    <div className="p-8 border-b border-white/10 flex justify-between items-center bg-white/5">
                        <h3 className="text-xs font-black uppercase tracking-widest text-[#B3A288]">Market Monitoring</h3>
                        <span className="text-[9px] font-bold text-gray-500 uppercase">Live Proof of Yield</span>
                    </div>
                    <YieldTable opportunities={opportunities} loading={loading} />
                  </div>
               </div>
               <div className="xl:col-span-4"><QuickSwap signer={signer} address={address || ""} /></div>
            </div>
            
            <div className="grid grid-cols-1 xl:grid-cols-12 gap-8 items-stretch mb-8">
               <div className="xl:col-span-8"><DecisionPanel decision={decision} latestHistoryDecision={proofs[0]} status={status} onRunAgent={() => {}} /></div>
               <div className="xl:col-span-4 h-full">
                   <div className="glass-card rounded-[2rem] h-full overflow-hidden flex flex-col bg-white/[0.02]">
                       <div className="p-6 border-b border-white/5 flex items-center justify-between">
                           <h2 className="text-[10px] font-black uppercase tracking-widest text-white/60">Execution History</h2>
                           <span className="text-[8px] font-black text-[#B3A288]">Verified</span>
                       </div>
                       <div className="flex-1 p-6 text-[9px] text-gray-500 font-bold italic text-center py-20">Protocol updates logged on-chain.</div>
                   </div>
               </div>
            </div>
          </>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
             {opportunities.map((opp, i) => (
                <div key={i} className="glass-card p-10 rounded-[3rem] border-white/5 hover:border-[#B3A288]/40 transition-all group">
                   <div className="flex justify-between items-start mb-10">
                      <div>
                         <h4 className="text-lg font-black text-white mb-2">{opp.protocol}</h4>
                         <span className="text-[10px] font-black uppercase tracking-[0.2em] text-[#B3A288] bg-[#B3A288]/10 px-4 py-2 rounded-xl">{opp.chain}</span>
                      </div>
                      <div className="text-right">
                         <div className="text-3xl font-black text-[#B3A288]">{opp.apr}%</div>
                         <div className="text-[8px] font-black text-gray-500 uppercase tracking-widest mt-1">Direct APR</div>
                      </div>
                   </div>
                   
                   <div className="space-y-4 mb-10">
                      <div className="flex justify-between text-[9px] font-black uppercase">
                         <span className="text-gray-500">Stability</span>
                         <span className="text-emerald-400">High / Verified</span>
                      </div>
                      <div className="w-full h-1 bg-white/5 rounded-full overflow-hidden">
                         <div className="h-full bg-emerald-500/40 w-full animate-pulse" />
                      </div>
                   </div>

                   <button 
                     onClick={() => handleManualMove(opp)}
                     disabled={status !== "idle"}
                     className="w-full py-5 rounded-2xl bg-white/5 border border-white/10 text-[10px] font-black uppercase tracking-[0.3em] text-white hover:bg-[#B3A288] hover:text-black transition-all cursor-pointer shadow-xl shadow-black/50"
                   >
                     Deploy Strategy
                   </button>
                </div>
             ))}
          </div>
        )}

        {activeTab === "dashboard" && (
           <div className="flex items-center justify-center gap-4 mb-20 mt-12">
               <RunAgentButton onClick={() => {}} disabled={status !== "idle"} status={status} />
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
