export const CHAINGPT_UPGRADE_URL = "https://app.chaingpt.org/pricing";

export const CHAINGPT_FEATURES = [
  {
    key: "chatbotEnabled",
    name: "Web3 chatbot",
    detail: "Hosted blockchain and crypto Q&A. Free-tier limits vary by account.",
    href: "https://app.chaingpt.org/",
  },
  {
    key: "contractAuditorEnabled",
    name: "Smart-contract auditor",
    detail: "External draft analysis only; it is not a security audit or deployment approval.",
    href: "https://app.chaingpt.org/",
  },
  {
    key: "contractGeneratorEnabled",
    name: "Smart-contract generator",
    detail: "External code drafts only; generated contracts are not approved for deployment.",
    href: "https://app.chaingpt.org/",
  },
  {
    key: "aiTradingAssistantEnabled",
    name: "AI trading analysis",
    detail: "Hosted chart and technical analysis; it cannot access or place Veylora orders.",
    href: "https://app.chaingpt.org/",
  },
  {
    key: "aiNewsEnabled",
    name: "AI-generated Web3 news",
    detail: "External news feed; verify claims with attributed primary sources.",
    href: "https://app.chaingpt.org/news",
  },
  {
    key: "askCryptoPeopleEnabled",
    name: "Ask Crypto People",
    detail: "Hosted community Q&A with account-specific free limits.",
    href: "https://app.chaingpt.org/",
  },
  {
    key: "nftGeneratorEnabled",
    name: "AI NFT generator",
    detail: "Image generation may be free; on-chain minting can incur network fees.",
    href: "https://nft.chaingpt.org/",
  },
  {
    key: "cryptoGuardEnabled",
    name: "CryptoGuard security extension",
    detail: "External browser extension for phishing and contract-risk checks.",
    href: "https://www.cryptoguard.ai/",
  },
  {
    key: "aiAgentsEnabled",
    name: "ChainGPT AI agents on X",
    detail: "Public social agents; X account and platform limits apply.",
    href: "https://x.com/ChainGPTAI",
  },
] as const;

export type ChainGPTFeatureKey = (typeof CHAINGPT_FEATURES)[number]["key"];

export type ChainGPTFeatureSettings = Record<ChainGPTFeatureKey, boolean>;

export const DEFAULT_CHAINGPT_FEATURE_SETTINGS: ChainGPTFeatureSettings = {
  chatbotEnabled: true,
  contractAuditorEnabled: true,
  contractGeneratorEnabled: true,
  aiTradingAssistantEnabled: true,
  aiNewsEnabled: true,
  askCryptoPeopleEnabled: true,
  nftGeneratorEnabled: true,
  cryptoGuardEnabled: true,
  aiAgentsEnabled: true,
};