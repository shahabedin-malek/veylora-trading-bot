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

export function MarketChart({
  candles,
  productId,
  failure = null,
}: {
  candles: readonly ChartCandle[];
  productId: string;
  /** Why the candles could not be read. Empty history and a failed read say different things. */
  failure?: string | null;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState<ChartRange>("1Y");
  const [style, setStyle] = useState<ChartStyle>("candles");
  const rsi = calculateRsi(candles.map((candle) => numeric(candle.close) ?? Number.NaN));
  // The range is measured back from the newest candle, not from the wall clock: a
  // provider that lags must not empty the chart, and the render stays deterministic.
  const reference = candles.at(-1) ? Date.parse(candles.at(-1)!.openTime) : Number.NaN;
  const cutoff = reference - ranges.find((item) => item.label === range)!.days * 86_400_000;
  const visible = Number.isFinite(cutoff) ? candles.filter((candle) => Date.parse(candle.openTime) >= cutoff) : [];
  const lastBar = candles.at(-1)?.openTime.slice(0, 10) ?? null;
  const canDraw = visible.length >= 2;
  const singleBar = visible.length === 1 ? visible[0] : null;

  useEffect(() => {
    let chart: import("lightweight-charts").IChartApi | null = null;
    let observer: ResizeObserver | null = null;
    let disposed = false;

    if (!canDraw) return;
    const newest = candles.at(-1) ? Date.parse(candles.at(-1)!.openTime) : Number.NaN;
    const boundary = newest - ranges.find((item) => item.label === range)!.days * 86_400_000;
    const selected = Number.isFinite(boundary)
      ? candles.filter((candle) => Date.parse(candle.openTime) >= boundary)
      : [];

    void import("lightweight-charts").then((library) => {
      const container = containerRef.current;
      if (!container || disposed || selected.length === 0) return;

      chart = library.createChart(container, {
        width: container.clientWidth,
        height: container.clientHeight || 330,
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
        const bounds = entries[0]?.contentRect;
        if (chart && bounds && bounds.width > 0) {
          chart.applyOptions({ width: bounds.width, height: bounds.height || undefined });
        }
      });
      observer.observe(container);
    });

    return () => {
      disposed = true;
      observer?.disconnect();
      chart?.remove();
    };
  }, [candles, range, style, canDraw]);

  if (candles.length === 0) {
    return (
      <div className="market-chart-wrap">
        <div className="market-chart-empty" role="status">
          <strong>{failure ? "Chart unavailable" : "No verified candle history"}</strong>
          <span>
            {failure ?? `${productId} historical candles are not shown here because the configured source returned none.`}
          </span>
          <small className="market-chart-updated">LAST STORED BAR · NONE</small>
        </div>
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
      {canDraw ? (
        <div aria-label={`${productId} historical price and volume chart`} className="market-chart-canvas" ref={containerRef} role="img" />
      ) : singleBar ? (
        <div className="market-chart-single" role="status">
          <div>
            <span>ONLY STORED BAR IN THIS RANGE</span>
            <strong>{singleBar.openTime.slice(0, 10)}</strong>
          </div>
          <dl>
            <div><dt>OPEN</dt><dd>{singleBar.open}</dd></div>
            <div><dt>HIGH</dt><dd>{singleBar.high}</dd></div>
            <div><dt>LOW</dt><dd>{singleBar.low}</dd></div>
            <div><dt>CLOSE</dt><dd>{singleBar.close}</dd></div>
            <div><dt>VOLUME</dt><dd>{singleBar.volume}</dd></div>
          </dl>
          <p>One bar is a reading, not a trend: a chart needs at least two closes. The stored bar is shown rather than a broken canvas.</p>
        </div>
      ) : (
        <div className="market-chart-empty" role="status">
          <strong>No bars in the selected range</strong>
          <span>
            {productId} has {candles.length} stored bar(s), none inside {range}. Choose a wider range; nothing is extrapolated.
          </span>
          <small className="market-chart-updated">LAST STORED BAR · {lastBar ?? "NONE"}</small>
        </div>
      )}
      <div className="market-chart-updated" role="status">
        LAST STORED BAR · {lastBar ?? "NONE"} · {visible.length} BAR(S) IN {range}
        {failure ? ` · READ FAILED: ${failure}` : ""}
      </div>
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