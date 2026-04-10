const { ethers } = require("ethers");
require("dotenv").config();

// --- Kite Ecosystem Addresses (Official) ---
const SERVICE_REGISTRY_ADDRESS = "0xc67a4AbcD8853221F241a041ACb1117b38DA587F";
const VAULT_ADDRESS = "0x9cCA18327e8B4a11fE8011695E4bb330a48237df"; // Our latest deployed Vault

const SERVICE_REGISTRY_ABI = [
  "function registerService(string serviceType, string pricingModel, uint256 unitPrice, string metadata) external returns (uint256)",
  "function getServiceInfo(uint256 serviceId) external view returns (string, string, uint256, string, address, bool)"
];

async function main() {
  console.log("🚀 Starting Official Kite App Store Onboarding for AllocAI...");
  const provider = new ethers.JsonRpcProvider("https://rpc.gokite.ai/");
  
  if (!process.env.AGENT_PRIVATE_KEY) {
    console.error("❌ AGENT_PRIVATE_KEY is missing in .env");
    return;
  }

  const wallet = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY, provider);
  const registry = new ethers.Contract(SERVICE_REGISTRY_ADDRESS, SERVICE_REGISTRY_ABI, wallet);

  // --- Registration Data ---
  const serviceType = "Autonomous Yield Vault";
  const pricingModel = "Performance Fee (5%)";
  const unitPrice = ethers.parseEther("0.05"); // 5% fee representation
  const metadata = JSON.stringify({
    name: "AllocAI",
    description: "Omnichain Autonomous Yield Agent powered by Kite AI.",
    version: "1.0.0-hackathon",
    vaultAddress: VAULT_ADDRESS,
    tags: ["yield", "ai-agent", "cross-chain", "layerzero"]
  });

  try {
    console.log(`📝 Registering AllocAI (Vault: ${VAULT_ADDRESS}) on Kite App Store...`);
    const tx = await registry.registerService(serviceType, pricingModel, unitPrice, metadata);
    console.log(`⏳ Waiting for confirmation... Tx Hash: ${tx.hash}`);
    const receipt = await tx.wait();
    
    console.log("✅ Successfully Registered on Kite App Store!");
    console.log(`🔗 Verified on Kite Chain: ${tx.hash}`);
    console.log("\n AllocAI is now officially discoverable by other Kite Agents.");
  } catch (err) {
    console.error("❌ Onboarding failed:", err.message);
    if (err.message.includes("insufficient funds")) {
      console.log("\n💡 Tip: Your Agent Wallet needs a tiny bit of KITE Mainnet for the registry fee.");
    }
  }
}

main();
