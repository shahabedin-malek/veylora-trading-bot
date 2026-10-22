"use client";

import { useEffect, useRef, useState } from "react";
import type { MarketQuote } from "@/lib/market-data/provider";
import { COINBASE_DEFAULT_PRODUCT_ID, COINBASE_WEBSOCKET_URL } from "@/lib/market-data/coinbase-config";

type StreamStatus = "CONNECTING" | "SUBSCRIBED" | "LIVE" | "RECONNECTING" | "SEQUENCE GAP";

type CoinbaseTickerMessage = {
  type: "ticker";
  product_id: string;
  price: string;
  best_bid: string;
  best_ask: string;
  time: string;
  sequence: number;
};

function isTickerMessage(value: unknown, productId: string): value is CoinbaseTickerMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    message.type === "ticker" &&
    message.product_id === productId &&
    typeof message.price === "string" &&
    /^\d+(?:\.\d+)?$/.test(message.price) &&
    typeof message.best_bid === "string" &&
    typeof message.best_ask === "string" &&
    typeof message.time === "string" &&
    Number.isSafeInteger(message.sequence)
  );
}

export function CoinbaseLiveTicker({
  initialQuote,
  productId = COINBASE_DEFAULT_PRODUCT_ID,
  compact = false,
}: {
  initialQuote: MarketQuote | null;
  productId?: string;
  compact?: boolean;
}) {
  const [price, setPrice] = useState(initialQuote?.last ?? null);
  const [bid, setBid] = useState(initialQuote?.bid ?? null);
  const [ask, setAsk] = useState(initialQuote?.ask ?? null);
  const [updatedAt, setUpdatedAt] = useState(initialQuote?.provenance.observedAt ?? null);
  const [status, setStatus] = useState<StreamStatus>("CONNECTING");
  const [isFresh, setIsFresh] = useState(initialQuote?.provenance.freshness === "FRESH");
  /** The last verified quote is still a reading when the stream drops; it is labelled, not hidden. */
  const [freshness, setFreshness] = useState(initialQuote?.provenance.freshness ?? "UNKNOWN");
  const updatedAtRef = useRef(updatedAt);

  useEffect(() => {
    let disposed = false;
    let attempt = 0;
    let lastSequence: number | null = null;
    let sequenceGapPending = false;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | undefined;

    const connect = () => {
      if (disposed) return;
      setStatus(attempt === 0 ? "CONNECTING" : "RECONNECTING");
      lastSequence = null;
      socket = new WebSocket(COINBASE_WEBSOCKET_URL);

      socket.addEventListener("open", () => {
        socket?.send(JSON.stringify({
          type: "subscribe",
          product_ids: [productId],
          channels: ["ticker", "heartbeat"],
        }));
        setStatus("SUBSCRIBED");
      });

      socket.addEventListener("message", (event) => {
        let message: unknown;
        try {
          message = JSON.parse(String(event.data));
        } catch {
          return;
        }
        if (typeof message !== "object" || message === null) return;

        const envelope = message as Record<string, unknown>;
        if (envelope.product_id !== productId || !Number.isSafeInteger(envelope.sequence)) return;
        const sequence = envelope.sequence as number;
        if (lastSequence !== null && sequence > lastSequence + 1) sequenceGapPending = true;
        if (lastSequence !== null && sequence <= lastSequence) return;
        lastSequence = sequence;

        if (!isTickerMessage(message, productId)) {
          if (sequenceGapPending) setStatus("SEQUENCE GAP");
          return;
        }
        setPrice(message.price);
        setBid(message.best_bid);
        setAsk(message.best_ask);
        setUpdatedAt(message.time);
        updatedAtRef.current = message.time;
        setIsFresh(true);
        setFreshness("FRESH");
        setStatus(sequenceGapPending ? "SEQUENCE GAP" : "LIVE");
        sequenceGapPending = false;
      });

      socket.addEventListener("close", () => {
        if (disposed) return;
        attempt += 1;
        setStatus((current) => current === "SEQUENCE GAP" ? current : "RECONNECTING");
        reconnectTimer = window.setTimeout(connect, Math.min(1_000 * 2 ** Math.min(attempt, 5), 30_000));
      });

      socket.addEventListener("error", () => socket?.close());
    };

    connect();
    const freshnessTimer = window.setInterval(() => {
      const observedAt = updatedAtRef.current ? Date.parse(updatedAtRef.current) : Number.NaN;
      setIsFresh(Number.isFinite(observedAt) && Date.now() - observedAt <= 30_000);
    }, 5_000);

    return () => {
      disposed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      window.clearInterval(freshnessTimer);
      socket?.close();
    };
  }, [productId]);

  return (
    <div className={`coinbase-ticker${compact ? " coinbase-ticker--compact" : ""}`}>
      <div className="coinbase-ticker__price-row">
        {/* A level-1 book has no last trade. Show the best ask, labelled as one, rather than
            an invented price or a blank while the stream is still connecting. */}
        <strong>{price ?? (ask ? `${ask} ASK` : "NO LAST TRADE")}</strong>
        <span className={`stream-state${status === "LIVE" && isFresh ? " is-live" : ""}`}>
          {status === "LIVE" && !isFresh ? "STALE" : status}
        </span>
      </div>
      {compact ? (
        <span className="coinbase-ticker__stamp">
          {updatedAt
            ? `${productId} · ${isFresh ? "observed" : `last verified (${freshness})`} ${new Date(updatedAt).toISOString()}`
            : `${productId} · waiting for a verified quote`}
        </span>
      ) : (
        <>
          <div className="coinbase-ticker__book">
            <div><span>BEST BID</span><strong>{bid ?? "—"}</strong></div>
            <div><span>BEST ASK</span><strong>{ask ?? "—"}</strong></div>
          </div>
          <span className="coinbase-ticker__stamp">
            {updatedAt
              ? `${isFresh ? "OBSERVED" : `LAST VERIFIED (${freshness})`} ${new Date(updatedAt).toISOString()}`
              : "Waiting for a verified public ticker update."}
          </span>
        </>
      )}
    </div>
  );
}