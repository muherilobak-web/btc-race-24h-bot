// Trend-following cbBTC bot for make.fun btc-race-24h-20261117-0603.
//
// The bot speaks agent-fun/bars-replay/v1 through vendor/makefun-bars.ts:
// the harness sends hello once, then one batch per minute (each batch carries
// the bar that just closed, the fills of the previous batch's orders and the
// account), and this bot answers every batch with exactly one reply echoing
// its seq. Orders decided on a batch fill at the next bar's open.
//
// Strategy: slow regime trend-following, very few trades, full size.
// The dev window is a noisy grind (per-minute sd 6.4 bps, single-minute
// jumps to 0.45%) with one real move: a dip to ~$63.9k, a spike to ~$65.4k
// that collapses back within 35 bars, then a slow rally to ~$65.5k and a
// fade. Fast trend signals buy the spike and sell the collapse, so this bot
// waits for the slow trend to confirm instead:
//   - Flat: buy only when SMA(90) is above SMA(360), SMA(360) has risen
//     over the last 120 bars, the close is above SMA(90) and clear of
//     SMA(360) by the entry gap. That keeps it in cash through the dip,
//     the spike and every chop in between.
//   - Long: exit on a trailing stop 200 bps below the peak close since
//     entry, or when the close falls under SMA(360) — the long trend
//     breaking. No fast cross-down exit: pullbacks must not shake it out.
//   - Then a cooldown before any new entry, so a stop-out is not chased
//     straight back into chop.
// A full round trip costs ~26 bps, so every trade must earn its keep: on
// the dev window this makes exactly one round trip.
// Everything is integer (bigint) math on raw price units: no wall clock, no
// network, no unseeded randomness, so two runs produce identical action
// logs byte for byte.

import { runBars, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

const FAST = 90;
const SLOW = 360;
const SLOPE_LB = 120;
const ENTRY_GAP_BPS = 10n;
const TRAIL_BPS = 200n;
const COOLDOWN_BARS = 60;
const MAX_SLIPPAGE_BPS = 100;
const BPS = 10_000n;

/** Closes (raw price units) in batch order; one entry per batch, latest known close. */
const closes: bigint[] = [];
/** Slow SMA value per batch (bigint), same index as closes. */
const slowHistory: bigint[] = [];
/** Highest close seen while holding the current position. */
let peakClose = 0n;
/** Seq of the last exit; no new entry until COOLDOWN_BARS have passed. */
let lastExitSeq = -1_000_000;
let symbol = 'CBBTC';

function sma(n: number): bigint | null {
  if (closes.length < n) return null;
  let sum = 0n;
  for (let i = closes.length - n; i < closes.length; i++) sum += closes[i]!;
  return sum / BigInt(n);
}

function entrySignal(state: BarsState): boolean {
  if (closes.length < SLOW) return false;
  if (state.seq - lastExitSeq < COOLDOWN_BARS) return false;
  const close = closes[closes.length - 1]!;
  const fast = sma(FAST);
  const slow = sma(SLOW);
  if (fast === null || slow === null) return false;
  if (fast <= slow) return false;
  if (close <= fast) return false;
  // Close clear of the slow SMA by the entry gap.
  if (close * BPS < slow * (BPS + ENTRY_GAP_BPS)) return false;
  // Slow SMA rising over the slope lookback: the long trend is up.
  const slowThen = slowHistory[slowHistory.length - 1 - SLOPE_LB];
  if (slowThen === undefined || slow <= slowThen) return false;
  return true;
}

function exitSignal(): boolean {
  const close = closes[closes.length - 1]!;
  if (close > peakClose) peakClose = close;
  // Trailing stop below the peak since entry.
  if (close * BPS <= peakClose * (BPS - TRAIL_BPS)) return true;
  // Long trend broken: close under the slow SMA.
  const slow = sma(SLOW);
  if (slow === null) return false;
  if (close < slow) return true;
  return false;
}

await runBars({
  onHello(state) {
    symbol = state.hello.symbols[0]!.symbol;
  },
  onBatch(state, batch): OrderInput[] {
    const close = state.close(symbol);
    closes.push(close ?? closes[closes.length - 1] ?? 0n);
    slowHistory.push(sma(SLOW) ?? slowHistory[slowHistory.length - 1] ?? 0n);
    // Warm-up batches build history only: any order on them is rejected.
    if (state.warmingUp) return [];
    const held = state.positions.get(symbol);
    if (held !== undefined && held.qty > 0n) {
      if (exitSignal()) {
        lastExitSeq = batch.seq;
        peakClose = 0n;
        return [{ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }
    if (!entrySignal(state)) return [];
    const room = state.weightRoom(symbol);
    const notional = state.cash < room ? state.cash : room;
    if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
    peakClose = closes[closes.length - 1]!;
    return [{ side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
