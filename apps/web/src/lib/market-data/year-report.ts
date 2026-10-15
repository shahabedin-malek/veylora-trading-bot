import DecimalJS from "decimal.js";

const Decimal = DecimalJS.clone({ precision: 100 });

export type YearReportCandle = {
  openTime: Date;
  high: string;
  low: string;
  close: string;
  volume: string;
};

export type YearMarketReport = {
  bars: number;
  startDate: string;
  endDate: string;
  startClose: string;
  endClose: string;
  periodChangePercent: string;
  high: string;
  low: string;
  volume: string;
};

function decimal(value: string): InstanceType<typeof Decimal> | null {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return null;
  const parsed = new Decimal(value);
  return parsed.isFinite() ? parsed : null;
}

export function buildYearMarketReport(candles: readonly YearReportCandle[]): YearMarketReport | null {
  if (candles.length < 2) return null;
  const ordered = [...candles].sort((left, right) => left.openTime.getTime() - right.openTime.getTime());
  if (ordered.some((candle) => !Number.isFinite(candle.openTime.getTime()))) return null;

  const first = ordered[0];
  const last = ordered.at(-1);
  if (!first || !last) return null;
  const startClose = decimal(first.close);
  const endClose = decimal(last.close);
  if (!startClose || startClose.isZero() || !endClose) return null;

  let high: InstanceType<typeof Decimal> | null = null;
  let low: InstanceType<typeof Decimal> | null = null;
  let volume = new Decimal(0);
  for (const candle of ordered) {
    const candleHigh = decimal(candle.high);
    const candleLow = decimal(candle.low);
    const candleVolume = decimal(candle.volume);
    if (!candleHigh || !candleLow || !candleVolume) return null;
    if (!high || candleHigh.greaterThan(high)) high = candleHigh;
    if (!low || candleLow.lessThan(low)) low = candleLow;
    volume = volume.plus(candleVolume);
  }
  if (!high || !low) return null;

  return {
    bars: ordered.length,
    startDate: first.openTime.toISOString().slice(0, 10),
    endDate: last.openTime.toISOString().slice(0, 10),
    startClose: startClose.toFixed(),
    endClose: endClose.toFixed(),
    periodChangePercent: endClose.minus(startClose).div(startClose).mul(100).toFixed(2),
    high: high.toFixed(),
    low: low.toFixed(),
    volume: volume.toFixed(),
  };
}