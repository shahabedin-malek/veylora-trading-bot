export const WUNDERTRADING_FEATURES = [
  {
    key: "apiProfilesEnabled",
    name: "Exchange profiles",
    detail: "Allow authenticated users to read their connected exchange API profiles.",
  },
  {
    key: "liveStrategiesEnabled",
    name: "Live strategies",
    detail: "Allow authenticated users to view active and recent strategies.",
  },
  {
    key: "strategyHistoryEnabled",
    name: "Strategy history",
    detail: "Allow authenticated users to read recent strategy history.",
  },
  {
    key: "openTradesEnabled",
    name: "Market-enter strategy",
    detail: "Allow entering an existing WunderTrading strategy at market, subject to Veylora's live-trading gates.",
  },
  {
    key: "closeTradesEnabled",
    name: "Market-close strategy",
    detail: "Allow closing an entered strategy at market, subject to Veylora's live-trading gates.",
  },
] as const;

export type WunderTradingFeatureKey = (typeof WUNDERTRADING_FEATURES)[number]["key"];
export type WunderTradingFeatureSettings = Record<WunderTradingFeatureKey, boolean>;

export const DEFAULT_WUNDERTRADING_FEATURE_SETTINGS: WunderTradingFeatureSettings = {
  apiProfilesEnabled: false,
  liveStrategiesEnabled: false,
  strategyHistoryEnabled: false,
  openTradesEnabled: false,
  closeTradesEnabled: false,
};