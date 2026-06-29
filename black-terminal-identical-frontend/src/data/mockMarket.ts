import { Candle } from "../chart-engine/types";

function rng(seed: number) {
  let s = seed;
  return () => {
    s = Math.sin(s) * 10000;
    return s - Math.floor(s);
  };
}

export function createMockCandles(count: number, timeframeSeconds = 60 * 15, anchorPrice = 66678.1): Candle[] {
  const rand = rng(1337);
  const currentBucket = Math.floor(Date.now() / 1000 / timeframeSeconds) * timeframeSeconds;
  const start = currentBucket - timeframeSeconds * count;
  const out: Candle[] = [];
  const timeframeScale = Math.max(0.42, Math.min(3.2, Math.sqrt(timeframeSeconds / (60 * 15))));
  const price = Math.max(0.0001, Number.isFinite(anchorPrice) ? anchorPrice : 66678.1);
  const bodyNoise = price * 0.00036 * timeframeScale;
  const waveFast = price * 0.00024 * timeframeScale;
  const waveSlow = price * 0.00036 * timeframeScale;
  const wickBase = price * 0.00012 * timeframeScale;
  const wickRange = price * 0.00033 * timeframeScale;
  const anchors = [
    [0, price * 0.977],
    [0.14, price * 0.993],
    [0.30, price * 0.983],
    [0.47, price * 0.992],
    [0.58, price * 1.008],
    [0.70, price * 0.995],
    [0.81, price * 1.007],
    [1, price]
  ] as const;

  const baselineAt = (t: number) => {
    for (let i = 1; i < anchors.length; i++) {
      const [prevT, prevPrice] = anchors[i - 1];
      const [nextT, nextPrice] = anchors[i];
      if (t <= nextT) {
        const n = (t - prevT) / (nextT - prevT);
        const smooth = n * n * (3 - 2 * n);
        return prevPrice + (nextPrice - prevPrice) * smooth;
      }
    }
    return anchors[anchors.length - 1][1];
  };

  let previousClose = baselineAt(0);

  for (let i = 0; i < count; i++) {
    const t = count <= 1 ? 1 : i / (count - 1);
    const open = previousClose;
    const noise = (rand() - 0.5) * bodyNoise;
    const close = i === count - 1
      ? price
      : baselineAt(t) + Math.sin(i / 6.2) * waveFast + Math.sin(i / 22) * waveSlow + noise;
    const upperWick = wickBase + rand() * wickRange + Math.abs(close - open) * (0.12 + rand() * 0.18);
    const lowerWick = wickBase + rand() * wickRange + Math.abs(close - open) * (0.12 + rand() * 0.18);
    const high = Math.max(open, close) + upperWick;
    const low = Math.min(open, close) - lowerWick;
    const volume = 420 + Math.abs(close - open) * 12 + rand() * 680 * timeframeScale;

    previousClose = close;
    out.push({
      time: start + i * timeframeSeconds,
      open,
      high,
      low,
      close,
      volume
    });
  }

  return out;
}
