"use client";

import React from "react";
import { useKiteWallet } from "@/hooks/useKiteWallet";

const WalletPanel: React.FC = () => {
  const { address, balance, loading, error, connect, disconnect, refreshBalance } = useKiteWallet();
  const [isRefreshing, setIsRefreshing] = React.useState(false);

  const handleManualRefresh = async () => {
    setIsRefreshing(true);
    await refreshBalance();
    setTimeout(() => setIsRefreshing(false), 1000);
  };

  const truncateAddress = (addr: string) => {
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  };

  const truncateBalance = (bal: string | null) => {
    if (!bal) return "0.000";
    const num = parseFloat(bal);
    return num.toLocaleString(undefined, { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  };

  if (!address) {
    return (
      <div className="flex flex-col items-end">
        <button 
          onClick={() => connect(true)}
          disabled={loading}
          className="h-12 flex items-center justify-center px-8 bg-[#B3A288] hover:bg-[#C9BAA2] text-black font-black uppercase tracking-[0.2em] text-[10px] rounded-xl transition-all shadow-[0_10px_20px_-5px_rgba(179,162,136,0.3)] hover:scale-[1.02] active:scale-95"
        >
          {loading ? "Initializing..." : "Connect Gateway"}
        </button>
        {error && (
          <p className="text-[10px] text-red-400 mt-2 font-black uppercase tracking-tighter opacity-70">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-4">
      <div className="flex items-center gap-6 p-1.5 pl-6 h-14 bg-[#111111]/80 backdrop-blur-2xl border border-white/10 rounded-2xl shadow-[0_20px_40px_-15px_rgba(0,0,0,0.5)] transition-all duration-500 hover:border-[#B3A288]/30 group">
        <div className="flex items-center gap-4">
          <div className="flex flex-col">
            <span className="text-[8px] font-black tracking-[0.2em] text-[#B3A288]/60 uppercase mb-0.5">
              Portfolio
            </span>
            <span className="text-sm font-black tabular-nums text-white flex items-baseline gap-1.5">
              {truncateBalance(balance)}
              <span className="text-[10px] text-gray-500 font-bold uppercase tracking-tighter">Kite</span>
            </span>
          </div>
          <button 
            onClick={handleManualRefresh}
            title="Force balance sync"
            className={`p-2 rounded-lg hover:bg-white/5 transition-all ${isRefreshing ? 'animate-spin opacity-50' : 'opacity-20 hover:opacity-100'}`}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M23 4v6h-6M1 20v-6h6M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          </button>
        </div>
        
        <div className="w-px h-8 bg-white/5 mx-1"></div>
        
        <div className="flex items-center gap-3">
          <div className="flex flex-col items-end">
             <div className="flex items-center gap-1.5 mb-0.5">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]"></span>
                <span className="text-[9px] font-black text-emerald-400 uppercase tracking-widest">Active</span>
             </div>
             <span className="text-[10px] font-black text-white/60 tabular-nums bg-white/5 px-2 py-0.5 rounded-md">
                {truncateAddress(address)}
             </span>
          </div>
          
          <button 
            onClick={() => disconnect()}
            title="Disconnect Wallet"
            className="w-10 h-10 rounded-xl bg-white/5 hover:bg-red-500/20 text-gray-400 hover:text-red-400 border border-white/10 flex items-center justify-center transition-all active:scale-90"
          >
             <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>
          </button>
        </div>
      </div>
    </div>
  );
};

export default WalletPanel;
