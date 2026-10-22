"use client";

import { RainbowKitProvider } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { createConfig, http, WagmiProvider } from "wagmi";
import { injected } from "wagmi/connectors";
import { mainnet } from "wagmi/chains";

/**
 * The app-wide wagmi/RainbowKit wrapper: injected wallets only.
 *
 * Mobile pairing is deliberately *not* configured here. Sign-in does not go
 * through these hooks any more — it reads an EIP-1193 provider directly
 * (`src/lib/auth/evm-wallet-sign-in.ts`) — and `/login` draws its own QR, deep
 * link and copy button and signs in through its own SIWE flow. Adding a
 * WalletConnect connector here would be a second pairing implementation: a
 * different modal, a different project-id precedence and its own connect step
 * competing with the page's. There is one pairing path, and it is the page's;
 * the project id is read in exactly one place
 * (`resolveWalletConnectProjectId`).
 */
const chains = [mainnet] as const;
const transports = { [mainnet.id]: http("/api/rpc/ethereum") };
const config = createConfig({ chains, connectors: [injected()], transports, ssr: true });

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
