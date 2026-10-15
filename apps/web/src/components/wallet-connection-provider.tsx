"use client";

import { getDefaultConfig, RainbowKitProvider } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { createConfig, http, WagmiProvider } from "wagmi";
import { injected } from "wagmi/connectors";
import { mainnet } from "wagmi/chains";

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim() ||
  process.env.NEXT_PUBLIC_REOWN_PROJECT_ID?.trim() || "";
const chains = [mainnet] as const;
const transports = { [mainnet.id]: http("/api/rpc/ethereum") };
const config = projectId
  ? getDefaultConfig({ appName: "Veylora", projectId, chains, transports, ssr: true })
  : createConfig({ chains, connectors: [injected()], transports, ssr: true });

export function WalletConnectionProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());
  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <RainbowKitProvider>{children}</RainbowKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}