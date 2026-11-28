// usage.stats (docs/protocol/settings.md, "Usage history"): each login's tokens by
// the hour and its limit readings over time, for the Usage panel's charts.
import type { Clock } from './clock.ts';
import { ErrorCode, RpcError } from './protocol.ts';
import type { HourRow, SpendRow, TokenTally } from './token-tally.ts';
import type { HistoryRow, UsageHistory } from './usage-history.ts';

export const DEFAULT_DAYS = 8;
export const MAX_DAYS = 14;

export type UsageStats = {
  generatedAt: string;
  ready: boolean;
  tokens: { accountId: string; hours: HourRow[] }[];
  limits: HistoryRow[];
  spend?: { accountId: string; hours: SpendRow[] }[];
};

export function usageStats(tally: TokenTally, history: UsageHistory, now: number, days = DEFAULT_DAYS): UsageStats {
  const since = now - days * 24 * 3_600_000;
  const spend = tally.spendRows(since);
  return {
    generatedAt: new Date(now).toISOString(),
    ready: tally.isReady(),
    tokens: tally.rows(since),
    limits: history.rows(since),
    ...(spend.length > 0 ? { spend } : {}),
  };
}

export function usageStatsMethods(o: { tally: TokenTally; history: UsageHistory; clock: Clock }): Record<string, (p: Record<string, unknown>) => unknown> {
  return {
    'usage.stats': (p) => {
      let days = DEFAULT_DAYS;
      if (p.days !== undefined && p.days !== null) {
        if (typeof p.days !== 'number' || !Number.isInteger(p.days) || p.days < 1 || p.days > MAX_DAYS) {
          throw new RpcError(ErrorCode.badParams, `days must be a whole number from 1 to ${MAX_DAYS}`);
        }
        days = p.days;
      }
      return usageStats(o.tally, o.history, o.clock.now(), days);
    },
  };
}
