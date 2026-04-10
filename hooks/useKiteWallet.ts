"use client";

import { useState, useEffect, useCallback } from "react";
import { ethers, BrowserProvider, JsonRpcSigner } from "ethers";
import { CURRENT_NETWORK } from "@/lib/networks";

export const useKiteWallet = () => {
  const [address, setAddress] = useState<string | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [provider, setProvider] = useState<BrowserProvider | null>(null);
  const [signer, setSigner] = useState<JsonRpcSigner | null>(null);
  const [mounted, setMounted] = useState<boolean>(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  const connect = useCallback(async (forceSelection: boolean = true) => {
    if (typeof window === "undefined" || !window.ethereum) {
      setError("Please install a wallet like MetaMask to use AllocAI.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      let ethProvider = window.ethereum;

      if (window.ethereum?.providers?.length) {
        ethProvider = window.ethereum.providers.find((p: any) => p.isMetaMask) || window.ethereum.providers[0];
      }

      const browserProvider = new BrowserProvider(ethProvider);
      
      if (forceSelection) {
        await browserProvider.send("wallet_requestPermissions", [
          { eth_accounts: {} },
        ]);
      }

      const accounts = await browserProvider.send("eth_requestAccounts", []);
      
      const chainIdHex = await browserProvider.send("eth_chainId", []);
      const chainId = parseInt(chainIdHex, 16);

      if (chainId !== CURRENT_NETWORK.chainId) {
        try {
          await browserProvider.send("wallet_switchEthereumChain", [
            { chainId: `0x${CURRENT_NETWORK.chainId.toString(16)}` },
          ]);
        } catch (switchError: any) {
          if (switchError.code === 4902) {
            try {
              await browserProvider.send("wallet_addEthereumChain", [
                {
                  chainId: `0x${CURRENT_NETWORK.chainId.toString(16)}`,
                  chainName: CURRENT_NETWORK.name,
                  rpcUrls: [CURRENT_NETWORK.rpcUrl],
                  nativeCurrency: {
                    name: CURRENT_NETWORK.currency,
                    symbol: CURRENT_NETWORK.currency,
                    decimals: 18,
                  },
                  blockExplorerUrls: [CURRENT_NETWORK.explorerUrl],
                },
              ]);
            } catch (addError) {
               console.error("Failed to add Kite network:", addError);
            }
          }
        }
      }

      const signerInstance = await browserProvider.getSigner();
      const accountsFinal = await browserProvider.send("eth_accounts", []);
      const balance = await browserProvider.getBalance(accountsFinal[0]);

      setAddress(accountsFinal[0]);
      setBalance(ethers.formatEther(balance));
      setProvider(browserProvider);
      setSigner(signerInstance);
    } catch (err: any) {
      console.error("Wallet connection failed:", err);
      setError(err.message || "Connection failed.");
    } finally {
      setLoading(false);
    }
  }, []);

  const disconnect = useCallback(() => {
    setAddress(null);
    setBalance(null);
    setSigner(null);
    setProvider(null);
  }, []);

  const refreshBalance = useCallback(async () => {
    if (typeof window === "undefined" || !window.ethereum || !address) return;
    
    try {
      const ethProvider = window.ethereum.providers?.length 
        ? (window.ethereum.providers.find((p: any) => p.isMetaMask) || window.ethereum.providers[0])
        : window.ethereum;
        
      const browserProvider = new BrowserProvider(ethProvider);
      const bal = await browserProvider.getBalance(address);
      setBalance(ethers.formatEther(bal));
      
      // Also update provider/signer in case they went stale
      setProvider(browserProvider);
      const signerInstance = await browserProvider.getSigner();
      setSigner(signerInstance);
    } catch (e) {
      console.error("Balance refresh failed:", e);
    }
  }, [address]);

  // Periodic refresh (every 15s)
  useEffect(() => {
    if (address) {
      const interval = setInterval(refreshBalance, 15000);
      return () => clearInterval(interval);
    }
  }, [address, refreshBalance]);

  // Eager Connection
  useEffect(() => {
    if (mounted && !address && typeof window !== "undefined" && window.ethereum) {
      window.ethereum.request({ method: "eth_accounts" })
        .then((accounts: string[]) => {
          if (accounts.length > 0) {
            connect(false);
          }
        })
        .catch(console.error);
    }
  }, [mounted, address, connect]);

  useEffect(() => {
    if (typeof window !== "undefined" && window.ethereum) {
      const handleAccountsChanged = (accounts: string[]) => {
        if (accounts.length > 0) {
          setAddress(accounts[0]);
          refreshBalance();
        } else {
          disconnect();
        }
      };
      window.ethereum.on("accountsChanged", handleAccountsChanged);
      return () => {
        window.ethereum.removeListener("accountsChanged", handleAccountsChanged);
      };
    }
  }, [disconnect, refreshBalance]);

  return { address, balance, loading, error, provider, signer, connect, disconnect, refreshBalance };
};
