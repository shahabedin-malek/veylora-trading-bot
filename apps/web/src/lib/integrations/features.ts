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
] as const;

export type IntegrationFeatureKey = (typeof INTEGRATION_FEATURES)[number]["key"];
export type IntegrationFeatureSettings = Record<IntegrationFeatureKey, boolean>;

export const DEFAULT_INTEGRATION_FEATURE_SETTINGS: IntegrationFeatureSettings = {
  alternativeMeSentimentEnabled: false,
  tavilySearchEnabled: false,
  tavilyExtractEnabled: false,
};
