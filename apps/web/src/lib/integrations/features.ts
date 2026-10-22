export const INTEGRATION_FEATURES = [
  {
    key: "alternativeMeSentimentEnabled",
    name: "Alternative.me Fear & Greed",
    detail: "Show the attributed daily Bitcoin sentiment index on Markets; informational only, never used for trading.",
  },
  {
    key: "tavilySearchEnabled",
    name: "Tavily Search",
    detail: "Allow signed-in users to run free, rate-limited keyless web searches.",
  },
  {
    key: "tavilyExtractEnabled",
    name: "Tavily Extract",
    detail: "Allow signed-in users to extract content from up to three public HTTPS URLs per request.",
  },
  {
    key: "sandbaseDataEnabled",
    name: "SandBase data (assistant social posts)",
    detail:
      "Allow the assistant's search_social_posts tool to call one pinned, currently-free SandBase " +
      "data API for public Twitter/X posts. Off means the tool refuses; it never falls back to a guess.",
  },
  {
    key: "testnetOrdersEnabled",
    name: "Binance Spot Testnet orders",
    detail:
      "Route orders to Binance Spot Testnet with each account's own testnet key (phase 21). Off means the development paper " +
      "venue, unless the owner's real-money switch in /admin/risk is on (phase 22); the live switch is data, not this flag.",
  },
] as const;

export type IntegrationFeatureKey = (typeof INTEGRATION_FEATURES)[number]["key"];
export type IntegrationFeatureSettings = Record<IntegrationFeatureKey, boolean>;

export const DEFAULT_INTEGRATION_FEATURE_SETTINGS: IntegrationFeatureSettings = {
  alternativeMeSentimentEnabled: false,
  tavilySearchEnabled: false,
  tavilyExtractEnabled: false,
  sandbaseDataEnabled: false,
  testnetOrdersEnabled: false,
};
