"use client";

import React from "react";

const Header: React.FC = () => {
  return (
    <div className="flex flex-col lg:flex-row items-center justify-between w-full">
      <div className="flex items-center group cursor-pointer hover:scale-105 transition-transform duration-300">
        <img src="/logo-v2.png" alt="AllocAI" className="h-14 w-auto px-2" />
        <div className="ml-2 hidden sm:block">
          <p className="text-[9px] font-black uppercase tracking-[0.2em] text-gray-500">
            AI-Powered Yield Intelligence on Kite
          </p>
        </div>
      </div>
      {/* Navigation removed to keep it minimal as per user request */}
    </div>
  );
};

export default Header;
