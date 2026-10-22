import { PublicRssProvider, type RssFeedConfig } from "@/lib/market-data/providers/cointelegraph-rss";
import { instrumentFetch } from "@/lib/observability/provider-call";

export const FINANCIAL_RSS_FEEDS: readonly RssFeedConfig[] = [
  {
    id: "bitcoin-magazine-rss",
    sourceName: "Bitcoin Magazine",
    url: "https://bitcoinmagazine.com/.rss/full/",
    allowedItemHosts: ["bitcoinmagazine.com", "www.bitcoinmagazine.com"],
    allowedImageHosts: [],
  },
  {
    id: "bitcoinist-rss",
    sourceName: "Bitcoinist",
    url: "https://bitcoinist.com/feed/",
    allowedItemHosts: ["bitcoinist.com", "www.bitcoinist.com"],
    allowedImageHosts: ["bitcoinist.com"],
  },
  {
    id: "coindesk-rss",
    sourceName: "CoinDesk",
    url: "https://www.coindesk.com/arc/outboundfeeds/rss/",
    allowedItemHosts: ["coindesk.com", "www.coindesk.com"],
    allowedImageHosts: ["cdn.sanity.io"],
  },
  {
    id: "cointelegraph-rss",
    sourceName: "Cointelegraph",
    url: "https://cointelegraph.com/rss",
    allowedItemHosts: ["cointelegraph.com"],
    allowedImageHosts: ["s3-images.ctmedia.io"],
  },
  {
    id: "cryptopotato-rss",
    sourceName: "CryptoPotato",
    url: "https://cryptopotato.com/feed/",
    allowedItemHosts: ["cryptopotato.com", "www.cryptopotato.com"],
    allowedImageHosts: ["cryptopotato.com"],
  },
  {
    id: "cryptoslate-rss",
    sourceName: "CryptoSlate",
    url: "https://cryptoslate.com/feed/",
    allowedItemHosts: ["cryptoslate.com", "www.cryptoslate.com"],
    allowedImageHosts: ["cryptoslate.com"],
  },
  {
    id: "decrypt-rss",
    sourceName: "Decrypt",
    url: "https://decrypt.co/feed",
    allowedItemHosts: ["decrypt.co", "www.decrypt.co"],
    allowedImageHosts: ["img.decrypt.co", "cdn.decrypt.co"],
  },
  {
    id: "newsbtc-rss",
    sourceName: "NewsBTC",
    url: "https://www.newsbtc.com/feed/",
    allowedItemHosts: ["newsbtc.com", "www.newsbtc.com"],
    allowedImageHosts: ["www.newsbtc.com"],
  },
  {
    id: "crypto-briefing-rss",
    sourceName: "Crypto Briefing",
    url: "https://cryptobriefing.com/feed/",
    allowedItemHosts: ["cryptobriefing.com", "www.cryptobriefing.com"],
    allowedImageHosts: ["static.cryptobriefing.com"],
  },
];

export const FINANCIAL_RSS_PROVIDER_IDS = FINANCIAL_RSS_FEEDS.map((feed) => feed.id);

export const FINANCIAL_RSS_PROVIDERS = FINANCIAL_RSS_FEEDS.map(
  (feed) => new PublicRssProvider(feed, instrumentFetch({ providerId: feed.id })),
);