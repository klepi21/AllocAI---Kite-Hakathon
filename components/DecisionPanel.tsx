"use client";

import React from "react";
import { AgentDecision } from "@/lib/types";

interface Props {
  decision: AgentDecision | null;
  latestHistoryDecision: any | null; // The latest proof from history
  status: string;
  onRunAgent: () => void;
}

const DecisionPanel: React.FC<Props> = ({ decision, latestHistoryDecision, status, onRunAgent }) => {
  const getStatusColor = () => {
    switch (status) {
      case "thinking": return "text-[#B3A288]";
      case "purchasing": return "text-purple-400";
      case "logging": return "text-blue-400";
      default: return "text-gray-500";
    }
  };

  const currentDisplay = decision || (status === "idle" && latestHistoryDecision ? {
    action: latestHistoryDecision.action.toLowerCase() === 'move' ? 'move' : 'hold',
    confidence: latestHistoryDecision.confidence,
    reason: latestHistoryDecision.reason,
    selectedOpportunity: { protocol: latestHistoryDecision.protocol, apr: 0 } // Mock for structure
  } : null);

  return (
    <div className="glass-card p-12 rounded-[2rem] relative overflow-hidden group h-full flex flex-col justify-center min-h-[300px]">
      <div className="absolute top-0 right-0 w-40 h-40 bg-[#B3A288]/5 blur-3xl group-hover:bg-[#B3A288]/10 transition-all rounded-full" />
      
      {!currentDisplay ? (
        <div className="flex flex-col items-start space-y-4">
           <div className="flex items-center space-x-6">
              <div className={`w-3 h-3 rounded-full animate-pulse transition-colors ${status === "idle" ? 'bg-gray-800' : 'bg-[#B3A288] shadow-lg shadow-[#B3A288]/50'}`} />
              <h2 className={`text-3xl font-black uppercase tracking-tight transition-colors ${getStatusColor()}`}>
                 {status === "idle" ? "Agent Idle" : `${status}...`}
              </h2>
           </div>
           <p className="text-[10px] font-black text-gray-500 max-w-sm leading-relaxed uppercase tracking-[0.2em] pt-2">
              The agent is currently waiting for a manual trigger. Click "Run Agent" to re-evaluate cross-chain yield opportunities.
           </p>
        </div>
      ) : (
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-8 h-full">
          <div className="flex-1">
             <div className="flex items-center space-x-4 mb-4">
                <span className={`px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest border border-white/5 ${currentDisplay.action === 'move' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-gray-500/10 text-gray-400'}`}>
                   {currentDisplay.action.toUpperCase()}
                </span>
                <span className="text-[10px] font-black text-gray-500 uppercase tracking-widest">Confidence: {(currentDisplay.confidence * 100).toFixed(0)}%</span>
                {!decision && status === "idle" && (
                   <span className="text-[9px] font-black text-emerald-400 uppercase tracking-widest bg-emerald-400/5 px-3 py-1.5 rounded-lg border border-emerald-400/10">Latest On-Chain Decision</span>
                )}
             </div>
             <h2 className="text-3xl font-black mb-4 tracking-tight leading-tight">
                {currentDisplay.action === 'move' 
                  ? `Reallocate to ${currentDisplay.selectedOpportunity?.protocol}` 
                  : "Maintain current position"}
             </h2>
             <p className="text-gray-400 text-[11px] font-bold max-w-lg leading-relaxed uppercase tracking-wider">{currentDisplay.reason}</p>
          </div>
          
          <div className="flex flex-col items-center justify-center p-8 bg-white/5 rounded-[2rem] border border-white/10 min-w-[180px] shadow-2xl backdrop-blur-3xl animate-in fade-in zoom-in slide-in-from-right-4">
             <p className="text-[10px] font-black text-gray-500 uppercase tracking-[0.2em] mb-2 text-center w-full">Impact</p>
             <p className="text-3xl font-black text-[#B3A288]">
               {currentDisplay.action === "move" ? "Active" : "Stable"}
             </p>
          </div>
        </div>
      )}
    </div>
  );
};

export default DecisionPanel;
