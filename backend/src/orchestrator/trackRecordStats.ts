/**
 * The published performance numbers, as one pure function over rows.
 *
 * Nothing here reads a database, a clock, or a quote. The whole point is that
 * anyone holding the append-only rows — including a Phase 4 subscriber — can
 * recompute these and get the same answer. That reproducibility *is* the
 * credibility argument (PRD §9), so a stored copy of any of it would be a
 * second version of the truth that can drift from the record it summarises.
 */

export interface TrackRecordRow {
  signalId: string;
  status: 'open' | 'closed';
  entryPrice: string;
  /** Shares in the entry lot, from the signal. */
  quantity: string;
  exitPrice: string | null;
  realizedPnl: string | null;
  unrealizedPnl: string | null;
  markPrice: string | null;
  recordedAt: Date;
}

export interface CurvePoint {
  /** UTC calendar day, `YYYY-MM-DD`. */
  date: string;
  /** Cumulative realized plus that day's unrealized. Null when withheld. */
  value: number | null;
  /** True when an open lot lacked a mark that day, so no honest total exists. */
  withheld: boolean;
}

export interface TrackRecordStats {
  closedTrades: number;
  openPositions: number;
  wins: number;
  /** Null with zero closed trades: no answer, rather than a claimed 0%. */
  winRate: number | null;
  /** Unweighted mean of per-trade returns. Null with zero closed trades. */
  averageReturn: number | null;
  totalRealizedPnl: number;
  curve: CurvePoint[];
}

const dayOf = (date: Date): string => date.toISOString().slice(0, 10);

export function computeTrackRecord(rows: readonly TrackRecordRow[]): TrackRecordStats {
  // Latest row per signal is the current truth. This is what makes corrections
  // work: a later row supersedes rather than double-counting, the same rule
  // `listOpenLots` follows.
  const latest = new Map<string, TrackRecordRow>();
  for (const row of rows) {
    const held = latest.get(row.signalId);
    if (!held || row.recordedAt.getTime() >= held.recordedAt.getTime()) {
      latest.set(row.signalId, row);
    }
  }

  const current = [...latest.values()];
  const closed = current.filter((row) => row.status === 'closed');
  const open = current.filter((row) => row.status === 'open');

  const wins = closed.filter((row) => Number(row.realizedPnl ?? 0) > 0).length;
  const totalRealizedPnl = closed.reduce((sum, row) => sum + Number(row.realizedPnl ?? 0), 0);

  const returns = closed.map((row) => {
    const basis = Number(row.entryPrice) * Number(row.quantity);
    return basis === 0 ? 0 : Number(row.realizedPnl ?? 0) / basis;
  });

  return {
    closedTrades: closed.length,
    openPositions: open.length,
    wins,
    winRate: closed.length === 0 ? null : wins / closed.length,
    averageReturn:
      returns.length === 0 ? null : returns.reduce((a, b) => a + b, 0) / returns.length,
    totalRealizedPnl,
    curve: buildCurve(rows),
  };
}

/**
 * One point per day on which something was recorded.
 *
 * A point is (cumulative realized PnL through that day) + (the sum of that
 * day's marks). If any lot that was open on the day lacks a mark for it, the
 * point is withheld rather than partially summed — the same rule the dashboard
 * applies to its totals, and it matters more here because these points are
 * published and the rows behind them can never be corrected in place.
 */
function buildCurve(rows: readonly TrackRecordRow[]): CurvePoint[] {
  const days = [...new Set(rows.map((row) => dayOf(row.recordedAt)))].sort();

  return days.map((date) => {
    const endOfDay = `${date}T23:59:59.999Z`;
    const through = rows.filter((row) => row.recordedAt.toISOString() <= endOfDay);

    // State of each lot as of the end of this day.
    const asOf = new Map<string, TrackRecordRow>();
    for (const row of through) {
      const held = asOf.get(row.signalId);
      if (!held || row.recordedAt.getTime() >= held.recordedAt.getTime()) {
        asOf.set(row.signalId, row);
      }
    }

    const realized = [...asOf.values()]
      .filter((row) => row.status === 'closed')
      .reduce((sum, row) => sum + Number(row.realizedPnl ?? 0), 0);

    const openLots = [...asOf.values()].filter((row) => row.status === 'open');
    const marksToday = new Map<string, number>();
    for (const row of rows) {
      if (row.markPrice != null && dayOf(row.recordedAt) === date) {
        marksToday.set(row.signalId, Number(row.unrealizedPnl ?? 0));
      }
    }

    const unmarked = openLots.filter((row) => !marksToday.has(row.signalId));
    if (unmarked.length > 0) {
      return { date, value: null, withheld: true };
    }

    const unrealized = [...marksToday.values()].reduce((a, b) => a + b, 0);
    return { date, value: realized + unrealized, withheld: false };
  });
}
