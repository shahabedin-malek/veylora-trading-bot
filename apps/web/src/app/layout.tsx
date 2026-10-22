import type { Metadata } from "next";
import type { ReactNode } from "react";
import { DevDatabaseBanner } from "@/components/dev-database-banner";
import { WalletConnectionProvider } from "@/components/wallet-connection-provider";
import "@rainbow-me/rainbowkit/styles.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Veylora | Trading Console",
  description: "Real-data trading console: wallet sign-in, market data, portfolio reads, paper strategies and an admin-configured risk policy.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <DevDatabaseBanner />
        <WalletConnectionProvider>{children}</WalletConnectionProvider>
      </body>
    </html>
  );
}
