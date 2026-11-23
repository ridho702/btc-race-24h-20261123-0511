// btc-race bot: an EMA trend rider for cbBTC on 1-minute bars.
//
// Idea, kept deliberately simple because a 1-minute tape plus ~40 bps of
// round-trip cost (4 bps fee + 2 bps slippage + constant-product impact
// against a ~$600k-deep pool) punishes every extra trade:
//   * ride the trend: buy the full $1,000 as soon as the fast EMA (12 bars)
//     crosses above the slow EMA (48 bars);
//   * hold through the chop: exit only on a wide trailing stop, 2.5% below
//     the highest close since entry. No exit on a fast/slow cross-down, no
//     profit target, no re-entry for 240 bars after an exit;
//   * never trade the last bars for their own sake: a position held to the
//     end is flattened by the harness at the last close.
// A $1 probe buy fires at bar 1380 if the bot has still never traded, so
// the race window always carries at least one trade even on a day that
// never shows an uptrend at all.
//
// Everything is integer math (BigInt) and deterministic: no clock, no
// environment, no randomness. The EMAs use the exact recurrence
//   e <- (e * (n - 1) + 2 * c) / (n + 1)
// truncated toward zero, so two runs on the same bars agree byte for byte.

import { runBars } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const FAST = 12n;
const SLOW = 48n;
const STOP_BPS = 250n; // trailing stop: sell 2.5% below the peak close
const COOLDOWN_BARS = 240; // bars to wait after an exit before re-entering
const FALLBACK_BAR = 1380; // if no trade has filled by here, buy $1
const FALLBACK_NOTIONAL = 1_000_000n; // $1 in micro-USDC
const FULL_NOTIONAL = 1_000_000_000n; // $1,000 in micro-USDC
const MAX_SLIPPAGE_BPS = 150; // 1-minute moves on the dev window peak at 72 bps

// ---- strategy state (built only from the bars the harness sends) ----
let emaFast: bigint | null = null;
let emaSlow: bigint | null = null;
let peakClose = 0n; // highest close seen since the current entry
let lastExitSeq = -1_000_000; // seq of the batch whose exit order was sent
let filledTrades = 0; // filled buy/sell orders seen so far in this run

function emaStep(e: bigint, close: bigint, n: bigint): bigint {
  return (e * (n - 1n) + 2n * close) / (n + 1n);
}

await runBars({
  onBatch(state, batch) {
    // Count what actually filled, so the fallback only fires when the bot
    // has truly never traded (a rejected order is not a trade).
    for (const f of batch.fills) if (f.status === 'filled') filledTrades++;

    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];
    const close = BigInt(bar.c);

    // Build the EMAs from every bar, warm-up bars included: they are
    // history to learn from, even though orders on them are rejected.
    if (emaFast === null || emaSlow === null) {
      emaFast = close;
      emaSlow = close;
    } else {
      emaFast = emaStep(emaFast, close, FAST);
      emaSlow = emaStep(emaSlow, close, SLOW);
    }
    if (state.warmingUp) return [];

    const qty = state.positions.get(SYMBOL)?.qty ?? 0n;

    if (qty === 0n) {
      // Flat: wait out the cooldown after an exit, then either take the
      // fallback probe (no trade yet, window nearly over) or enter on the
      // uptrend signal.
      if (state.seq - lastExitSeq < COOLDOWN_BARS) return [];
      if (filledTrades === 0 && state.seq >= FALLBACK_BAR) {
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: FALLBACK_NOTIONAL, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      if (emaFast > emaSlow) {
        const notional = state.cash < FULL_NOTIONAL ? state.cash : FULL_NOTIONAL;
        if (notional <= 0n) return [];
        peakClose = close;
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Holding: track the peak close and sell only on the trailing stop.
    if (close > peakClose) peakClose = close;
    const drawdownBps = peakClose === 0n ? 0n : ((peakClose - close) * 10000n) / peakClose;
    if (drawdownBps >= STOP_BPS) {
      lastExitSeq = state.seq;
      return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  },
});
