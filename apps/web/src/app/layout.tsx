import type { Metadata } from "next";
import type { ReactNode } from "react";
import { WalletConnectionProvider } from "@/components/wallet-connection-provider";
import "@rainbow-me/rainbowkit/styles.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "Veylora | Trading Console",
  description: "Real-data trading console. Connections and execution remain disabled until approved.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body><WalletConnectionProvider>{children}</WalletConnectionProvider></body>
    </html>
  );
}
