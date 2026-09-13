import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REBATE_PER_TURNOVER = 10000;
export const REBATE_AMOUNT = 475;

export type LedgerBet = {
  id: string;
  session_id: string;
  member_id?: string;
  lottery_id: number;
  issue: string;
  picks: number[];
  bet_amount: number;
  total_cost: number;
  status: string;
  result_number: number | null;
  payout: number;
  net: number;
  created_at: string;
  settled_at: string | null;
  position: number;
  remote_ids?: string[];
};

export type DailySummaryRow = {
  date: string;
  dateLabel: string;
  turnover: number;
  net: number;
  rebate: number;
  wins: number;
  losses: number;
  pending: number;
  settled: number;
  winRate: number | null;
};

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const ledgerPath = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "bet-ledger.json");

let records: LedgerBet[] = [];
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function roundMoney(value: number): number {
  return Math.round(value * 100) / 100;
}

export function beijingDate(iso: string): string {
  const ms = Date.parse(iso);
  const date = Number.isFinite(ms) ? new Date(ms) : new Date();
  return date.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });
}

export function beijingDateLabel(ymd: string): string {
  const match = ymd.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return ymd;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const weekday = WEEKDAYS[new Date(Date.UTC(year, month - 1, day, 4, 0, 0)).getUTCDay()] ?? "";
  return `${year}年${match[2]}月${match[3]}日 ${weekday}`;
}

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const raw = readFileSync(ledgerPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return;
    records = parsed.filter((item) => item && typeof item === "object" && typeof (item as LedgerBet).id === "string") as LedgerBet[];
  } catch {
    records = [];
  }
}

function flush() {
  ensureLoaded();
  mkdirSync(dirname(ledgerPath), { recursive: true });
  const tmp = `${ledgerPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(records, null, 2));
  renameSync(tmp, ledgerPath);
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      flush();
    } catch {
      // ignore disk errors
    }
  }, 200);
}

export function loadLedger(memberId?: string): LedgerBet[] {
  ensureLoaded();
  if (!memberId) return records;
  return records.filter((item) => item.member_id === memberId);
}

export function upsertBet(bet: LedgerBet) {
  ensureLoaded();
  const index = records.findIndex((item) => item.id === bet.id);
  const copy = { ...bet, picks: [...bet.picks], remote_ids: bet.remote_ids ? [...bet.remote_ids] : undefined };
  if (index >= 0) records[index] = copy;
  else records.push(copy);
  scheduleSave();
}

export function removeBet(betId: string) {
  ensureLoaded();
  const next = records.filter((item) => item.id !== betId);
  if (next.length === records.length) return;
  records = next;
  scheduleSave();
}

export function clearLedger(memberId?: string) {
  ensureLoaded();
  if (!memberId) records = [];
  else records = records.filter((item) => item.member_id !== memberId);
  persistLedgerNow();
}

export function persistLedgerNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  try {
    flush();
  } catch {
    // ignore
  }
}

export function dailySummary(memberId?: string): DailySummaryRow[] {
  ensureLoaded();
  const source = memberId ? records.filter((item) => item.member_id === memberId) : records;
  const groups = new Map<string, DailySummaryRow>();
  for (const bet of source) {
    const date = beijingDate(bet.created_at);
    let row = groups.get(date);
    if (!row) {
      row = {
        date,
        dateLabel: beijingDateLabel(date),
        turnover: 0,
        net: 0,
        rebate: 0,
        wins: 0,
        losses: 0,
        pending: 0,
        settled: 0,
        winRate: null,
      };
      groups.set(date, row);
    }
    row.turnover += Number(bet.total_cost) || 0;
    if (bet.status === "won") {
      row.wins += 1;
      row.settled += 1;
      row.net += Number(bet.net) || 0;
    } else if (bet.status === "lost") {
      row.losses += 1;
      row.settled += 1;
      row.net += Number(bet.net) || 0;
    } else if (bet.status === "pending") {
      row.pending += 1;
    }
  }
  const rows = [...groups.values()].sort((a, b) => b.date.localeCompare(a.date));
  for (const row of rows) {
    row.turnover = roundMoney(row.turnover);
    row.net = roundMoney(row.net);
    row.rebate = roundMoney((row.turnover / REBATE_PER_TURNOVER) * REBATE_AMOUNT);
    row.winRate = row.settled > 0 ? row.wins / row.settled : null;
  }
  return rows;
}

export type LedgerTotals = {
  turnover: number;
  net: number;
  rebate: number;
  wins: number;
  losses: number;
  pending: number;
  settled: number;
  winRate: number | null;
};

export function summarizeDays(days: DailySummaryRow[]): LedgerTotals {
  const totals: LedgerTotals = {
    turnover: 0,
    net: 0,
    rebate: 0,
    wins: 0,
    losses: 0,
    pending: 0,
    settled: 0,
    winRate: null,
  };
  for (const row of days) {
    totals.turnover += row.turnover;
    totals.net += row.net;
    totals.rebate += row.rebate;
    totals.wins += row.wins;
    totals.losses += row.losses;
    totals.pending += row.pending;
    totals.settled += row.settled;
  }
  totals.turnover = roundMoney(totals.turnover);
  totals.net = roundMoney(totals.net);
  totals.rebate = roundMoney(totals.rebate);
  totals.winRate = totals.settled > 0 ? totals.wins / totals.settled : null;
  return totals;
}
