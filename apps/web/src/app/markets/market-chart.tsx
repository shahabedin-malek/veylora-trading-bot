"use client";

import { useEffect, useRef, useState } from "react";
import type { UTCTimestamp } from "lightweight-charts";
import { calculateRsi } from "@/lib/market-data/indicators";

export type ChartCandle = {
  openTime: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
};

const ranges = [
  { label: "1D", days: 1 },
  { label: "1W", days: 7 },
  { label: "1M", days: 30 },
  { label: "3M", days: 90 },
  { label: "1Y", days: 365 },
] as const;

type ChartRange = (typeof ranges)[number]["label"];
type ChartStyle = "candles" | "line";

function numeric(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function MarketChart({ candles, productId }: { candles: readonly ChartCandle[]; productId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<ChartRange>("1Y");
  const [style, setStyle] = useState<ChartStyle>("candles");
  const rsi = calculateRsi(candles.map((candle) => numeric(candle.close) ?? Number.NaN));

  useEffect(() => {
    let chart: import("lightweight-charts").IChartApi | null = null;
    let observer: ResizeObserver | null = null;
    let disposed = false;

    const selected = candles.filter((candle) => {
      const cutoff = Date.now() - ranges.find((item) => item.label === range)!.days * 86_400_000;
      return Date.parse(candle.openTime) >= cutoff;
    });

    void import("lightweight-charts").then((library) => {
      const container = containerRef.current;
      if (!container || disposed || selected.length === 0) return;

      chart = library.createChart(container, {
        width: container.clientWidth,
        height: 330,
        layout: {
          background: { type: library.ColorType.Solid, color: "transparent" },
          textColor: "#8b9a97",
          fontFamily: '"IBM Plex Mono", monospace',
          fontSize: 10,
          attributionLogo: true,
        },
        grid: {
          vertLines: { color: "rgba(139,154,151,0.08)" },
          horzLines: { color: "rgba(139,154,151,0.08)" },
        },
        rightPriceScale: { borderColor: "#273536" },
        timeScale: { borderColor: "#273536", timeVisible: false, rightOffset: 3 },
        crosshair: { vertLine: { color: "#60706d" }, horzLine: { color: "#60706d" } },
      });

      const candleData = selected.flatMap((candle) => {
        const open = numeric(candle.open);
        const high = numeric(candle.high);
        const low = numeric(candle.low);
        const close = numeric(candle.close);
        const time = Math.floor(Date.parse(candle.openTime) / 1_000) as UTCTimestamp;
        return open === null || high === null || low === null || close === null ? [] : [{ time, open, high, low, close }];
      });

      if (style === "candles") {
        chart.addSeries(library.CandlestickSeries, {
          upColor: "#a8e4bd",
          downColor: "#ed9886",
          borderVisible: false,
          wickUpColor: "#a8e4bd",
          wickDownColor: "#ed9886",
        }).setData(candleData);
      } else {
        chart.addSeries(library.LineSeries, {
          color: "#99c9e3",
          lineWidth: 2,
          priceLineVisible: false,
        }).setData(candleData.map(({ time, close }) => ({ time, value: close })));
      }

      chart.addSeries(library.HistogramSeries, {
        priceScaleId: "volume",
        priceFormat: { type: "volume" },
        lastValueVisible: false,
        priceLineVisible: false,
      }).setData(candleData.map((candle) => {
        const source = selected.find((item) => Math.floor(Date.parse(item.openTime) / 1_000) === candle.time);
        return {
          time: candle.time,
          value: numeric(source?.volume ?? "") ?? 0,
          color: candle.close >= candle.open ? "rgba(168,228,189,0.45)" : "rgba(237,152,134,0.45)",
        };
      }));

      chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      chart.timeScale().fitContent();
      observer = new ResizeObserver((entries) => {
        const width = entries[0]?.contentRect.width;
        if (chart && width && width > 0) chart.applyOptions({ width });
      });
      observer.observe(container);
    });

    return () => {
      disposed = true;
      observer?.disconnect();
      chart?.remove();
    };
  }, [candles, range, style]);

  if (candles.length === 0) {
    return (
      <div className="market-chart-empty" role="status">
        <strong>No verified candle history</strong>
        <span>{productId} historical candles are not shown here because the configured source returned none.</span>
      </div>
    );
  }

  return (
    <div className="market-chart-wrap">
      <div className="market-chart-controls">
        <div className="segmented-control" aria-label="Chart type">
          <button aria-pressed={style === "candles"} onClick={() => setStyle("candles")} type="button">Candles</button>
          <button aria-pressed={style === "line"} onClick={() => setStyle("line")} type="button">Line</button>
        </div>
        <div className="segmented-control" aria-label="Chart range">
          {ranges.map(({ label }) => (
            <button aria-pressed={range === label} key={label} onClick={() => setRange(label)} type="button">{label}</button>
          ))}
        </div>
      </div>
      <div aria-label={`${productId} historical price and volume chart`} className="market-chart-canvas" ref={containerRef} />
      <div className="market-indicator-strip" aria-label="Historical technical indicator">
        <div className="market-indicator-strip__metric">
          <span>WILDER / 14 DAILY BARS</span>
          <strong>{rsi === null ? "UNAVAILABLE" : rsi.toFixed(2)}</strong>
        </div>
        <p>Relative strength index from stored Coinbase candles. Informational only; not a trading signal.</p>
      </div>
    </div>
  );
}