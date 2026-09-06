import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import {
  TrendingUp,
  Hash,
  BarChart3,
  Award,
  RefreshCw,
  Loader2,
  AlertCircle,
  LogOut,
  Wallet,
  Zap,
  X,
} from 'lucide-react';
import { LoginScreen } from '@/LoginScreen';
import { AutoBetPanel } from '@/AutoBetPanel';
import { API_URL, API_HEADERS } from '@/api';
import type { DrawResult } from '@/lotteryData';

type TabKey = 'table' | 'frequency' | 'trend' | 'profit' | 'autobet';

const WINDOW_MIN = 1;
const WINDOW_MAX = 100;
const DEFAULT_WINDOW = 15;
const PICK_MIN = 1;
const PICK_MAX = 10;
const DEFAULT_PICK = 7;
const SESSION_KEY = 'lottery-session-id';
const WINDOW_KEY = 'lottery-window-size';
const PICK_KEY = 'lottery-pick-count';
const DEDUP_KEY = 'lottery-exclude-last';
const MARTINGALE_ON_KEY = 'lottery-martingale-on';
const MARTINGALE_FACTOR_KEY = 'lottery-martingale-factor';
const MARTINGALE_RESET_KEY = 'lottery-martingale-reset';
const GAME_KEY = 'lottery-game-id';
const DRAWS_KEY_LEGACY = 'lottery-draws';
const MARTINGALE_FACTOR_MIN = 1.01;
const MARTINGALE_FACTOR_MAX = 10;
const DEFAULT_MARTINGALE_FACTOR = 2;
const MARTINGALE_RESET_MIN = 1;
const MARTINGALE_RESET_MAX = 20;
const DEFAULT_MARTINGALE_RESET = 3;
const AUTO_BET_ON_KEY = 'lottery-auto-bet-on';
const BET_AMOUNT_KEY = 'lottery-bet-amount';
const DEFAULT_BET_AMOUNT = 100;

type GameId = 60 | 127 | 128;

const GAMES: { id: GameId; label: string }[] = [
  { id: 128, label: '腾讯10分彩' },
  { id: 127, label: '腾讯5分彩' },
  { id: 60, label: '腾讯分分彩' },
];

function drawsStorageKey(gameId: GameId): string {
  return `lottery-draws-${gameId}`;
}

function isGameId(value: number): value is GameId {
  return GAMES.some((g) => g.id === value);
}

function readStoredGame(): GameId {
  try {
    const raw = Number.parseInt(localStorage.getItem(GAME_KEY) ?? '', 10);
    if (isGameId(raw)) return raw;
  } catch {
    // ignore
  }
  return 128;
}

function persistGame(gameId: GameId) {
  try {
    localStorage.setItem(GAME_KEY, String(gameId));
  } catch {
    // ignore quota / private mode
  }
}

function gameLabel(gameId: GameId): string {
  return GAMES.find((g) => g.id === gameId)?.label ?? '腾讯10分彩';
}

function persistSession(id: string | null) {
  try {
    if (id) localStorage.setItem(SESSION_KEY, id);
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    // ignore quota / private mode
  }
}

function readStoredWindow(): number {
  try {
    const raw = localStorage.getItem(WINDOW_KEY);
    if (!raw) return DEFAULT_WINDOW;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_WINDOW;
    return Math.min(WINDOW_MAX, Math.max(WINDOW_MIN, parsed));
  } catch {
    return DEFAULT_WINDOW;
  }
}

function persistWindow(size: number) {
  try {
    localStorage.setItem(WINDOW_KEY, String(size));
  } catch {
    // ignore quota / private mode
  }
}

function readStoredPick(): number {
  try {
    const raw = localStorage.getItem(PICK_KEY);
    if (!raw) return DEFAULT_PICK;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_PICK;
    return Math.min(PICK_MAX, Math.max(PICK_MIN, parsed));
  } catch {
    return DEFAULT_PICK;
  }
}

function persistPick(size: number) {
  try {
    localStorage.setItem(PICK_KEY, String(size));
  } catch {
    // ignore quota / private mode
  }
}

function readStoredExcludeLast(): boolean {
  try {
    return localStorage.getItem(DEDUP_KEY) === '1';
  } catch {
    return false;
  }
}

function persistExcludeLast(value: boolean) {
  try {
    localStorage.setItem(DEDUP_KEY, value ? '1' : '0');
  } catch {
    // ignore quota / private mode
  }
}

function readStoredMartingaleOn(): boolean {
  try {
    return localStorage.getItem(MARTINGALE_ON_KEY) === '1';
  } catch {
    return false;
  }
}

function persistMartingaleOn(value: boolean) {
  try {
    localStorage.setItem(MARTINGALE_ON_KEY, value ? '1' : '0');
  } catch {
    // ignore quota / private mode
  }
}

function clampMartingaleFactor(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return Math.min(MARTINGALE_FACTOR_MAX, Math.max(MARTINGALE_FACTOR_MIN, rounded));
}

function readStoredMartingaleFactor(): number {
  try {
    const raw = localStorage.getItem(MARTINGALE_FACTOR_KEY);
    if (!raw) return DEFAULT_MARTINGALE_FACTOR;
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) return DEFAULT_MARTINGALE_FACTOR;
    return clampMartingaleFactor(parsed);
  } catch {
    return DEFAULT_MARTINGALE_FACTOR;
  }
}

function persistMartingaleFactor(value: number) {
  try {
    localStorage.setItem(MARTINGALE_FACTOR_KEY, String(value));
  } catch {
    // ignore quota / private mode
  }
}

function readStoredMartingaleReset(): number {
  try {
    const raw = localStorage.getItem(MARTINGALE_RESET_KEY);
    if (!raw) return DEFAULT_MARTINGALE_RESET;
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return DEFAULT_MARTINGALE_RESET;
    return Math.min(MARTINGALE_RESET_MAX, Math.max(MARTINGALE_RESET_MIN, parsed));
  } catch {
    return DEFAULT_MARTINGALE_RESET;
  }
}

function persistMartingaleReset(value: number) {
  try {
    localStorage.setItem(MARTINGALE_RESET_KEY, String(value));
  } catch {
    // ignore quota / private mode
  }
}

function readStoredAutoBetOn(): boolean {
  try {
    return localStorage.getItem(AUTO_BET_ON_KEY) === '1';
  } catch {
    return false;
  }
}

function persistAutoBetOn(value: boolean) {
  try {
    localStorage.setItem(AUTO_BET_ON_KEY, value ? '1' : '0');
  } catch {
    // ignore
  }
}

function readStoredBetAmount(): number {
  try {
    const raw = localStorage.getItem(BET_AMOUNT_KEY);
    if (!raw) return DEFAULT_BET_AMOUNT;
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_BET_AMOUNT;
    return parsed;
  } catch {
    return DEFAULT_BET_AMOUNT;
  }
}

function persistBetAmount(value: number) {
  try {
    localStorage.setItem(BET_AMOUNT_KEY, String(value));
  } catch {
    // ignore
  }
}

function mergeDraws(prev: DrawResult[], incoming: DrawResult[]): DrawResult[] {
  const map = new Map<string, DrawResult>();
  for (const draw of prev) map.set(draw.issue, draw);
  for (const draw of incoming) map.set(draw.issue, draw);
  return [...map.values()].sort((a, b) => b.issue.localeCompare(a.issue));
}

function parseStoredDraws(raw: string | null): DrawResult[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw) as DrawResult[];
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (d) => d && typeof d.issue === 'string' && Array.isArray(d.numbers) && d.numbers.length === 5
  );
}

function readStoredDraws(gameId: GameId): DrawResult[] {
  try {
    const current = parseStoredDraws(localStorage.getItem(drawsStorageKey(gameId)));
    if (current.length > 0) return current;
    if (gameId === 128) {
      return parseStoredDraws(localStorage.getItem(DRAWS_KEY_LEGACY));
    }
    return [];
  } catch {
    return [];
  }
}

function persistDraws(gameId: GameId, draws: DrawResult[]) {
  try {
    localStorage.setItem(drawsStorageKey(gameId), JSON.stringify(draws));
  } catch {
    // ignore quota / private mode
  }
}

function clearStoredDraws() {
  try {
    localStorage.removeItem(DRAWS_KEY_LEGACY);
    for (const game of GAMES) {
      localStorage.removeItem(drawsStorageKey(game.id));
    }
  } catch {
    // ignore
  }
}

function sum(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0);
}

function nextIssue(issue: string): string | null {
  const hyphenated = issue.match(/^(\d{8})-(\d{1,4})$/);
  const compact = issue.match(/^(\d{8})(\d{1,4})$/);
  const match = hyphenated ?? compact;
  if (!match) return null;
  const seqStr = match[2];
  const width = seqStr.length;
  const sequence = Number.parseInt(seqStr, 10) + 1;
  return `${match[1]}-${String(sequence).padStart(width, '0')}`;
}

export const ballColor = (n: number): string => {
  const colors = [
    'from-rose-500 to-rose-600',
    'from-orange-500 to-orange-600',
    'from-amber-500 to-amber-600',
    'from-emerald-500 to-emerald-600',
    'from-teal-500 to-teal-600',
    'from-cyan-500 to-cyan-600',
    'from-sky-500 to-sky-600',
    'from-blue-500 to-blue-600',
    'from-indigo-500 to-indigo-600',
    'from-violet-500 to-violet-600',
  ];
  return colors[n] ?? 'from-slate-500 to-slate-600';
};

function StatCard({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: string | number;
  sub?: string;
  accent: string;
}) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-sm transition hover:shadow-md">
      <div className={`absolute inset-x-0 top-0 h-1 ${accent}`} />
      <p className="text-xs font-medium uppercase tracking-wider text-slate-500">{label}</p>
      <p className="mt-2 text-3xl font-bold text-slate-900">{value}</p>
      {sub && <p className="mt-1 text-sm text-slate-500">{sub}</p>}
    </div>
  );
}

export function NumberBall({ n, size = 'md' }: { n: number; size?: 'sm' | 'md' | 'lg' }) {
  const sizes = {
    sm: 'h-7 w-7 text-xs',
    md: 'h-10 w-10 text-base',
    lg: 'h-14 w-14 text-xl',
  };
  return (
    <span
      className={`inline-flex items-center justify-center rounded-full bg-gradient-to-br ${ballColor(
        n
      )} ${sizes[size]} font-bold text-white shadow-sm ring-2 ring-white/40`}
    >
      {n}
    </span>
  );
}

type RecResult = { picks: number[]; hit: boolean; eligible: boolean };

function computePicksFromHistory(
  history: DrawResult[],
  pickCount: number,
  excludeLast: boolean
): number[] {
  const geCounts = new Array(10).fill(0);
  const transition: number[][] = Array.from({ length: 10 }, () => new Array(10).fill(0));
  let prevGe = -1;

  for (const draw of history) {
    const ge = draw.numbers[4];
    geCounts[ge]++;
    if (prevGe >= 0) {
      transition[prevGe][ge]++;
    }
    prevGe = ge;
  }

  const maxHot = Math.max(...geCounts) || 1;
  let transScore = new Array(10).fill(0);
  if (prevGe >= 0) {
    const row = transition[prevGe];
    const maxT = Math.max(...row);
    if (maxT > 0) {
      transScore = row.map((c) => (c / maxT) * 100);
    }
  }
  const scores = new Array(10).fill(0);
  for (let n = 0; n < 10; n++) {
    scores[n] = (geCounts[n] / maxHot) * 55 + transScore[n] * 45;
  }
  const ranked = scores
    .map((s, n) => ({ s, n }))
    .filter(({ n }) => !excludeLast || n !== prevGe)
    .sort((a, b) => b.s - a.s)
    .slice(0, pickCount)
    .map((x) => x.n)
    .sort((a, b) => a - b);
  return ranked;
}

function buildRecommendations(
  data: DrawResult[],
  windowSize: number,
  pickCount: number,
  excludeLast: boolean
): { recs: Map<string, RecResult>; nextPicks: number[]; hasEnough: boolean; evaluatedCount: number } {
  const recs = new Map<string, RecResult>();
  const oldestFirst = [...data].sort((a, b) => a.issue.localeCompare(b.issue));
  const hasEnough = oldestFirst.length >= windowSize && windowSize >= WINDOW_MIN;

  if (!hasEnough) {
    for (const draw of oldestFirst) {
      recs.set(draw.issue, { picks: [], hit: false, eligible: false });
    }
    return { recs, nextPicks: [], hasEnough: false, evaluatedCount: 0 };
  }

  for (let i = 0; i < oldestFirst.length; i++) {
    if (i < windowSize) {
      recs.set(oldestFirst[i].issue, { picks: [], hit: false, eligible: false });
      continue;
    }
    const history = oldestFirst.slice(i - windowSize, i);
    const picks = computePicksFromHistory(history, pickCount, excludeLast);
    const ge = oldestFirst[i].numbers[4];
    recs.set(oldestFirst[i].issue, { picks, hit: picks.includes(ge), eligible: true });
  }

  const nextPicks = computePicksFromHistory(oldestFirst.slice(-windowSize), pickCount, excludeLast);
  return {
    recs,
    nextPicks,
    hasEnough: true,
    evaluatedCount: Math.max(0, oldestFirst.length - windowSize),
  };
}

function computeStreaks(data: DrawResult[], recs: Map<string, RecResult>): { maxWin: number; maxLoss: number } {
  const oldestFirst = [...data].sort((a, b) => a.issue.localeCompare(b.issue));
  let maxWin = 0;
  let maxLoss = 0;
  let curWin = 0;
  let curLoss = 0;

  for (const draw of oldestFirst) {
    const rec = recs.get(draw.issue);
    if (!rec?.eligible) continue;
    if (rec.hit) {
      curWin += 1;
      curLoss = 0;
      maxWin = Math.max(maxWin, curWin);
    } else {
      curLoss += 1;
      curWin = 0;
      maxLoss = Math.max(maxLoss, curLoss);
    }
  }

  return { maxWin, maxLoss };
}

function DataTable({
  data,
  recs,
  pickCount,
}: {
  data: DrawResult[];
  recs: Map<string, RecResult>;
  pickCount: number;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="max-h-[640px] overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-slate-50 backdrop-blur">
            <tr className="text-left text-slate-600">
              <th className="px-4 py-3 font-semibold">序号</th>
              <th className="px-4 py-3 font-semibold">期号</th>
              <th className="px-4 py-3 font-semibold">开奖时间</th>
              <th className="px-4 py-3 font-semibold">开奖号码</th>
              <th className="px-4 py-3 font-semibold">个位推荐 ({pickCount}码)</th>
              <th className="px-4 py-3 font-semibold">是否中奖</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.map((row, idx) => {
              const ge = row.numbers[4];
              const rec = recs.get(row.issue) ?? { picks: [], hit: false, eligible: false };
              return (
                <tr key={row.issue} className="transition hover:bg-sky-50/60">
                  <td className="px-4 py-3 text-slate-400">{idx + 1}</td>
                  <td className="px-4 py-3 font-mono text-slate-700">{row.issue}</td>
                  <td className="px-4 py-3 text-slate-500">{row.time}</td>
                  <td className="px-4 py-3">
                    <div className="flex gap-1.5">
                      {row.numbers.map((n, i) => (
                        <NumberBall key={i} n={n} size="sm" />
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {rec.eligible ? (
                      <div className="flex flex-wrap gap-1">
                        {rec.picks.map((n, i) => (
                          <span
                            key={i}
                            className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ring-1 ${
                              n === ge
                                ? 'bg-emerald-500 text-white ring-emerald-600'
                                : 'bg-slate-100 text-slate-600 ring-slate-200'
                            }`}
                          >
                            {n}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs text-slate-400">样本不足</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    {!rec.eligible ? (
                      <span className="text-xs text-slate-400">—</span>
                    ) : rec.hit ? (
                      <span className="inline-flex rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
                        中
                      </span>
                    ) : (
                      <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-400">
                        未中
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FrequencyChart({ data, windowSize }: { data: DrawResult[]; windowSize: number }) {
  const windowed = useMemo(() => {
    const newestFirst = [...data].sort((a, b) => b.issue.localeCompare(a.issue));
    return newestFirst.slice(0, windowSize);
  }, [data, windowSize]);

  const stats = useMemo(() => {
    const counts = new Array(10).fill(0);
    windowed.forEach((d) => counts[d.numbers[4]]++);
    const max = Math.max(...counts);
    return counts.map((c, n) => ({ n, count: c, pct: max === 0 ? 0 : (c / max) * 100 }));
  }, [windowed]);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-6 flex items-center gap-2">
        <BarChart3 className="h-5 w-5 text-sky-600" />
        <h3 className="text-lg font-semibold text-slate-800">
          个位号码出现频次（最近 {windowed.length} 期）
        </h3>
      </div>
      <div className="space-y-3">
        {stats.map(({ n, count, pct }) => (
          <div key={n} className="flex items-center gap-3">
            <NumberBall n={n} size="sm" />
            <div className="h-7 flex-1 overflow-hidden rounded-lg bg-slate-100">
              <div
                className={`h-full rounded-lg bg-gradient-to-r ${ballColor(n)} transition-all duration-700 ease-out`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="w-16 text-right text-sm font-semibold text-slate-700">
              {count} 次
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TrendChart({ data }: { data: DrawResult[] }) {
  const reversed = useMemo(() => [...data].reverse(), [data]);
  const points = reversed.map((d) => sum(d.numbers));
  const maxV = 45;
  const minV = 0;
  const w = 800;
  const h = 280;
  const pad = 40;
  const stepX = (w - pad * 2) / Math.max(points.length - 1, 1);
  const scaleY = (v: number) => h - pad - ((v - minV) / (maxV - minV)) * (h - pad * 2);

  const pathD = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${pad + i * stepX} ${scaleY(p)}`)
    .join(' ');

  const areaD = `${pathD} L ${pad + (points.length - 1) * stepX} ${h - pad} L ${pad} ${h - pad} Z`;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
      <div className="mb-4 flex items-center gap-2">
        <TrendingUp className="h-5 w-5 text-emerald-600" />
        <h3 className="text-lg font-semibold text-slate-800">总和走势图</h3>
      </div>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${w} ${h}`} className="w-full min-w-[640px]" preserveAspectRatio="none">
          <defs>
            <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity="0.35" />
              <stop offset="100%" stopColor="#10b981" stopOpacity="0.02" />
            </linearGradient>
            <linearGradient id="trendLine" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#0ea5e9" />
              <stop offset="100%" stopColor="#10b981" />
            </linearGradient>
          </defs>
          {[0, 10, 20, 30, 40, 45].map((v) => (
            <g key={v}>
              <line
                x1={pad}
                y1={scaleY(v)}
                x2={w - pad}
                y2={scaleY(v)}
                stroke="#e2e8f0"
                strokeWidth="1"
                strokeDasharray={v === 25 ? '0' : '4 4'}
              />
              <text x={pad - 8} y={scaleY(v) + 4} textAnchor="end" className="fill-slate-400 text-[10px]">
                {v}
              </text>
            </g>
          ))}
          <path d={areaD} fill="url(#trendFill)" />
          <path d={pathD} fill="none" stroke="url(#trendLine)" strokeWidth="2.5" strokeLinejoin="round" />
          {points.map((p, i) => (
            <circle
              key={i}
              cx={pad + i * stepX}
              cy={scaleY(p)}
              r="3"
              className="fill-white stroke-emerald-500"
              strokeWidth="2"
            />
          ))}
        </svg>
      </div>
      <p className="mt-3 text-center text-xs text-slate-400">
        虚线为大小分界 (25) · 共 {points.length} 期
      </p>
    </div>
  );
}

function ProfitSim({
  data,
  recs,
  hasEnough,
  windowSize,
  pickCount,
  martingaleOn,
  martingaleFactor,
  martingaleReset,
}: {
  data: DrawResult[];
  recs: Map<string, RecResult>;
  hasEnough: boolean;
  windowSize: number;
  pickCount: number;
  martingaleOn: boolean;
  martingaleFactor: number;
  martingaleReset: number;
}) {
  const ODDS = 9.77;
  const BET_PER_NUMBER = 100;
  const INITIAL_CAPITAL = 10000;
  const REBATE_PER_TURNOVER = 10000;
  const REBATE_AMOUNT = 475;

  const sim = useMemo(() => {
    const oldestFirst = [...data].sort((a, b) => a.issue.localeCompare(b.issue));
    const eligible = oldestFirst.filter((draw) => recs.get(draw.issue)?.eligible);

    let balance = INITIAL_CAPITAL;
    let wins = 0;
    let losses = 0;
    let totalBet = 0;
    let totalWin = 0;
    let totalRebate = 0;
    let totalBetNet = 0;
    let lossStreakAmount = 0;
    let lossStreakCount = 0;
    let maxLossStreakAmount = 0;
    let maxLossStreakCount = 0;
    let multiplier = 1;
    let martingaleLosses = 0;
    const rows: {
      issue: string;
      time: string;
      ge: number;
      picks: number[];
      hit: boolean;
      cost: number;
      ret: number;
      rebate: number;
      betNet: number;
      net: number;
      balance: number;
      multiplier: number;
    }[] = [];

    for (const draw of eligible) {
      const rec = recs.get(draw.issue);
      const picks = rec?.picks ?? [];
      const ge = draw.numbers[4];
      const hit = rec?.hit ?? false;
      const stakeMul = multiplier;
      const baseCost = BET_PER_NUMBER * pickCount;
      const cost = baseCost * stakeMul;
      const ret = hit ? BET_PER_NUMBER * ODDS * stakeMul : 0;
      const rebate = (cost / REBATE_PER_TURNOVER) * REBATE_AMOUNT;
      const betNet = ret - cost;
      const net = betNet + rebate;
      balance += betNet;
      totalBet += cost;
      totalWin += ret;
      totalRebate += rebate;
      totalBetNet += betNet;
      if (hit) {
        wins++;
        lossStreakAmount = 0;
        lossStreakCount = 0;
        multiplier = 1;
        martingaleLosses = 0;
      } else {
        losses++;
        lossStreakAmount += -betNet;
        lossStreakCount += 1;
        if (lossStreakAmount > maxLossStreakAmount) {
          maxLossStreakAmount = lossStreakAmount;
          maxLossStreakCount = lossStreakCount;
        }
        if (martingaleOn) {
          martingaleLosses += 1;
          if (martingaleLosses > martingaleReset) {
            multiplier = 1;
            martingaleLosses = 0;
          } else {
            multiplier *= martingaleFactor;
          }
        }
      }
      rows.push({
        issue: draw.issue,
        time: draw.time,
        ge,
        picks,
        hit,
        cost,
        ret,
        rebate,
        betNet,
        net,
        balance,
        multiplier: stakeMul,
      });
    }

    const finalBalance = balance;
    const betRoi = ((totalBetNet / INITIAL_CAPITAL) * 100).toFixed(1);
    const winRate = eligible.length === 0 ? '0.0' : ((wins / eligible.length) * 100).toFixed(1);

    return {
      rows: rows.reverse(),
      finalBalance: finalBalance.toFixed(2),
      totalBetNet: totalBetNet.toFixed(2),
      betRoi,
      winRate,
      wins,
      losses,
      total: eligible.length,
      totalBet: totalBet.toFixed(2),
      totalRebate: totalRebate.toFixed(2),
      totalWin: totalWin.toFixed(2),
      maxLossStreakAmount: maxLossStreakAmount.toFixed(2),
      maxLossStreakCount,
    };
  }, [data, recs, pickCount, martingaleOn, martingaleFactor, martingaleReset]);

  if (!hasEnough || sim.total === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center shadow-sm">
        <p className="text-sm font-medium text-slate-700">开奖记录不足，无法计算盈亏</p>
        <p className="mt-2 text-sm text-slate-500">
          当前统计窗口为 {windowSize} 期，需要至少 {windowSize + 1} 期开奖记录才能回测已开奖期。
        </p>
      </div>
    );
  }

  const isBetProfit = parseFloat(sim.totalBetNet) >= 0;

  return (
    <div className="space-y-6">
      {/* Balance curve with integrated stats */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2">
            <Wallet className="h-5 w-5 text-emerald-600" />
            <h3 className="text-lg font-semibold text-slate-800">余额走势 ({sim.total}期)</h3>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
            <span>赔率 {ODDS}</span>
            <span className="text-slate-300">|</span>
            <span>每码 ¥{BET_PER_NUMBER} · {pickCount}码</span>
            <span className="text-slate-300">|</span>
            <span>本金 ¥{INITIAL_CAPITAL}</span>
            <span className="text-slate-300">|</span>
            <span>流水奖励 每{REBATE_PER_TURNOVER}返{REBATE_AMOUNT}</span>
            {martingaleOn && (
              <>
                <span className="text-slate-300">|</span>
                <span>
                  倍投 {martingaleFactor}倍 · 连不中 {martingaleReset} 次回到 1 倍
                </span>
              </>
            )}
          </div>
        </div>

        {/* Inline key metrics */}
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <div className="rounded-xl bg-slate-50 px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wider text-slate-400">最终余额</p>
            <p className="mt-1 text-xl font-bold text-slate-900">¥{sim.finalBalance}</p>
            <p className="text-xs text-slate-500">本金 + 投注盈亏 · 不含流水奖</p>
          </div>
          <div className="rounded-xl bg-slate-50 px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wider text-slate-400">投注盈亏</p>
            <p className={`mt-1 text-xl font-bold ${isBetProfit ? 'text-emerald-600' : 'text-rose-600'}`}>
              {isBetProfit ? '+' : ''}¥{sim.totalBetNet}
            </p>
            <p className={`text-xs ${isBetProfit ? 'text-emerald-500' : 'text-rose-500'}`}>
              相对本金 {sim.betRoi}% · 不含流水奖
            </p>
          </div>
          <div className="rounded-xl bg-slate-50 px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wider text-slate-400">下注总流水</p>
            <p className="mt-1 text-xl font-bold text-slate-900">¥{sim.totalBet}</p>
            <p className="text-xs text-slate-500">各期下注金额合计</p>
          </div>
          <div className="rounded-xl bg-slate-50 px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wider text-slate-400">流水奖励</p>
            <p className="mt-1 text-xl font-bold text-emerald-700">¥{sim.totalRebate}</p>
            <p className="text-xs text-slate-500">
              每 ¥{REBATE_PER_TURNOVER} 返 ¥{REBATE_AMOUNT}
            </p>
          </div>
          <div className="rounded-xl bg-slate-50 px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wider text-slate-400">中奖次数</p>
            <p className="mt-1 text-xl font-bold text-slate-900">{sim.wins} / {sim.total}</p>
            <p className="text-xs text-slate-500">命中率 {sim.winRate}%</p>
          </div>
          <div className="rounded-xl bg-slate-50 px-4 py-3">
            <p className="text-xs font-medium uppercase tracking-wider text-slate-400">最大连败金额</p>
            <p className="mt-1 text-xl font-bold text-slate-900">¥{sim.maxLossStreakAmount}</p>
            <p className="text-xs text-slate-500">
              {sim.maxLossStreakCount > 0
                ? `连续未中 ${sim.maxLossStreakCount} 期累计亏损`
                : '暂无连败'}
            </p>
          </div>
        </div>

        <BalanceChart rows={sim.rows} initialCapital={INITIAL_CAPITAL} />
      </div>

      {/* Detail table */}
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="max-h-[480px] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-slate-50 backdrop-blur">
              <tr className="text-left text-slate-600">
                <th className="px-4 py-3 font-semibold">期号</th>
                <th className="px-4 py-3 font-semibold">开奖号码</th>
                <th className="px-4 py-3 font-semibold">推荐{pickCount}码</th>
                <th className="px-4 py-3 font-semibold">结果</th>
                <th className="px-4 py-3 font-semibold text-right">倍数</th>
                <th className="px-4 py-3 font-semibold text-right">下注</th>
                <th className="px-4 py-3 font-semibold text-right">回报</th>
                <th className="px-4 py-3 font-semibold text-right">投注盈亏</th>
                <th className="px-4 py-3 font-semibold text-right">余额</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {sim.rows.map((row) => (
                <tr key={row.issue} className="transition hover:bg-sky-50/60">
                  <td className="px-4 py-3 font-mono text-slate-700">{row.issue}</td>
                  <td className="px-4 py-3">
                    <span className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-violet-600 text-xs font-bold text-white shadow-sm ring-2 ring-white/40">
                      {row.ge}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      {row.picks.map((n, i) => (
                        <span
                          key={i}
                          className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ring-1 ${
                            n === row.ge
                              ? 'bg-emerald-500 text-white ring-emerald-600'
                              : 'bg-slate-100 text-slate-600 ring-slate-200'
                          }`}
                        >
                          {n}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    {row.hit ? (
                      <span className="inline-flex rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
                        中
                      </span>
                    ) : (
                      <span className="inline-flex rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-400">
                        未中
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right font-medium text-slate-700">
                    {Number.isInteger(row.multiplier) ? row.multiplier : row.multiplier.toFixed(2)}x
                  </td>
                  <td className="px-4 py-3 text-right text-slate-600">¥{row.cost.toFixed(2)}</td>
                  <td className="px-4 py-3 text-right text-slate-600">¥{row.ret.toFixed(2)}</td>
                  <td className={`px-4 py-3 text-right font-semibold ${row.betNet >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                    {row.betNet >= 0 ? '+' : ''}¥{row.betNet.toFixed(2)}
                  </td>
                  <td className={`px-4 py-3 text-right font-semibold ${row.balance >= INITIAL_CAPITAL ? 'text-emerald-700' : 'text-rose-700'}`}>
                    ¥{row.balance.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function BalanceChart({
  rows,
  initialCapital,
}: {
  rows: { issue: string; balance: number }[];
  initialCapital: number;
}) {
  const points = [...rows].reverse().map((r) => r.balance);
  const allVals = [...points, initialCapital];
  const maxV = Math.max(...allVals);
  const minV = Math.min(...allVals, 0);
  const range = maxV - minV || 1;
  const w = 800;
  const h = 240;
  const pad = 40;
  const stepX = (w - pad * 2) / Math.max(points.length - 1, 1);
  const scaleY = (v: number) => h - pad - ((v - minV) / range) * (h - pad * 2);

  const pathD = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${pad + i * stepX} ${scaleY(p)}`)
    .join(' ');
  const areaD = `${pathD} L ${pad + (points.length - 1) * stepX} ${h - pad} L ${pad} ${h - pad} Z`;
  const baseLineY = scaleY(initialCapital);

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full min-w-[640px]" preserveAspectRatio="none">
        <defs>
          <linearGradient id="profitFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#10b981" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#10b981" stopOpacity="0.02" />
          </linearGradient>
          <linearGradient id="profitLine" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#0ea5e9" />
            <stop offset="100%" stopColor="#10b981" />
          </linearGradient>
        </defs>
        <line
          x1={pad}
          y1={baseLineY}
          x2={w - pad}
          y2={baseLineY}
          stroke="#f43f5e"
          strokeWidth="1.5"
          strokeDasharray="6 4"
        />
        <text x={pad - 8} y={baseLineY + 4} textAnchor="end" className="fill-rose-400 text-[10px]">
          本金
        </text>
        <path d={areaD} fill="url(#profitFill)" />
        <path d={pathD} fill="none" stroke="url(#profitLine)" strokeWidth="2.5" strokeLinejoin="round" />
        {points.map((p, i) => (
          <circle
            key={i}
            cx={pad + i * stepX}
            cy={scaleY(p)}
            r="3"
            className="fill-white stroke-emerald-500"
            strokeWidth="2"
          />
        ))}
      </svg>
      <p className="mt-3 text-center text-xs text-slate-400">
        红色虚线为本金 ¥{initialCapital} · 共 {points.length} 期
      </p>
    </div>
  );
}

function App() {
  const [sessionId, setSessionId] = useState<string | null>(() => {
    try {
      return localStorage.getItem(SESSION_KEY);
    } catch {
      return null;
    }
  });
  const [gameId, setGameId] = useState<GameId>(readStoredGame);
  const [draws, setDraws] = useState<DrawResult[]>(() => readStoredDraws(readStoredGame()));
  const [loadingDraws, setLoadingDraws] = useState(false);
  const [drawsError, setDrawsError] = useState('');
  const [betError, setBetError] = useState('');
  const [tab, setTab] = useState<TabKey>('table');
  const [search, setSearch] = useState('');
  const [windowSize, setWindowSize] = useState(readStoredWindow);
  const [windowDraft, setWindowDraft] = useState(() => String(readStoredWindow()));
  const [pickCount, setPickCount] = useState(readStoredPick);
  const [pickDraft, setPickDraft] = useState(() => String(readStoredPick()));
  const [excludeLast, setExcludeLast] = useState(readStoredExcludeLast);
  const [martingaleOn, setMartingaleOn] = useState(readStoredMartingaleOn);
  const [martingaleFactor, setMartingaleFactor] = useState(readStoredMartingaleFactor);
  const [martingaleFactorDraft, setMartingaleFactorDraft] = useState(() =>
    String(readStoredMartingaleFactor())
  );
  const [martingaleReset, setMartingaleReset] = useState(readStoredMartingaleReset);
  const [martingaleResetDraft, setMartingaleResetDraft] = useState(() =>
    String(readStoredMartingaleReset())
  );
  const [autoBetOn, setAutoBetOn] = useState(readStoredAutoBetOn);
  const [betAmount, setBetAmount] = useState(readStoredBetAmount);
  const [placingBet, setPlacingBet] = useState(false);
  const [lastBetIssue, setLastBetIssue] = useState<string | null>(null);
  const gameIdRef = useRef(gameId);
  gameIdRef.current = gameId;

  const fetchDraws = useCallback(async (sid: string, lotteryId: GameId) => {
    setLoadingDraws(true);
    setDrawsError('');
    try {
      const resp = await fetch(`${API_URL}?action=draws`, {
        method: 'POST',
        headers: API_HEADERS,
        body: JSON.stringify({ sessionId: sid, issueCount: 100, lotteryId }),
      });

      if (resp.status === 401 || resp.status === 400) {
        persistSession(null);
        clearStoredDraws();
        setSessionId(null);
        setDraws([]);
        const payload = (await resp.json().catch(() => ({}))) as { error?: string };
        setDrawsError(payload.error || '登录已过期，请重新登录');
        return;
      }

      if (!resp.ok) throw new Error(`获取数据失败 (${resp.status})`);

      const data = await resp.json();
      if (data.error) throw new Error(data.error);

      if (Array.isArray(data.draws) && data.draws.length > 0) {
        const next = mergeDraws(readStoredDraws(lotteryId), data.draws as DrawResult[]);
        persistDraws(lotteryId, next);
        if (gameIdRef.current === lotteryId) {
          setDraws(next);
        }
      } else if (gameIdRef.current === lotteryId) {
        setDrawsError('未获取到开奖数据，请稍后重试');
      }
    } catch (err) {
      if (gameIdRef.current === lotteryId) {
        setDrawsError(err instanceof Error ? err.message : '获取数据失败');
      }
    } finally {
      if (gameIdRef.current === lotteryId) {
        setLoadingDraws(false);
      }
    }
  }, []);

  const handleLoginSuccess = useCallback((sid: string) => {
    persistSession(sid);
    setSessionId(sid);
  }, []);

  const handleLogout = useCallback(() => {
    persistSession(null);
    clearStoredDraws();
    setSessionId(null);
    setDraws([]);
    setDrawsError('');
    setLastBetIssue(null);
  }, []);

  const placeBet = useCallback(async (issue: string, picks: number[]) => {
    if (!sessionId || !issue || picks.length === 0) return;
    setPlacingBet(true);
    try {
      const resp = await fetch(`${API_URL}?action=bet`, {
        method: 'POST',
        headers: API_HEADERS,
        body: JSON.stringify({
          sessionId,
          lotteryId: gameId,
          issue,
          picks,
          betAmount,
        }),
      });
      const data = await resp.json();
      if (data.success) {
        setLastBetIssue(issue);
        setBetError('');
      } else if (data.error) {
        setBetError(data.error);
      }
      if (data.debug) {
        console.log('bet debug', data.debug);
      }
    } catch {
      setBetError('投注请求失败，请检查网络连接');
    } finally {
      setPlacingBet(false);
    }
  }, [sessionId, gameId, betAmount]);

  const applyGame = useCallback((next: GameId) => {
    persistGame(next);
    setGameId(next);
    setDraws(readStoredDraws(next));
    setDrawsError('');
    setSearch('');
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    fetchDraws(sessionId, gameId);
    const interval = setInterval(() => fetchDraws(sessionId, gameId), 60000);
    return () => clearInterval(interval);
  }, [sessionId, gameId, fetchDraws]);

  const recommendation = useMemo(
    () => buildRecommendations(draws, windowSize, pickCount, excludeLast),
    [draws, windowSize, pickCount, excludeLast]
  );

  useEffect(() => {
    if (!autoBetOn || !sessionId || draws.length === 0 || !recommendation.hasEnough) return;
    const targetIssue = nextIssue(draws[0]?.issue ?? '');
    if (!targetIssue || targetIssue === lastBetIssue) return;
    const picks = recommendation.nextPicks;
    if (picks.length === 0) return;
    placeBet(targetIssue, picks);
  }, [autoBetOn, sessionId, draws, recommendation, lastBetIssue, placeBet]);

  const applyWindowSize = useCallback((raw: string) => {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
      setWindowDraft(String(windowSize));
      return;
    }
    const next = Math.min(WINDOW_MAX, Math.max(WINDOW_MIN, parsed));
    persistWindow(next);
    setWindowSize(next);
    setWindowDraft(String(next));
  }, [windowSize]);

  const applyPickCount = useCallback((raw: string) => {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
      setPickDraft(String(pickCount));
      return;
    }
    const next = Math.min(PICK_MAX, Math.max(PICK_MIN, parsed));
    persistPick(next);
    setPickCount(next);
    setPickDraft(String(next));
  }, [pickCount]);

  const applyMartingaleFactor = useCallback((raw: string) => {
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) {
      setMartingaleFactorDraft(String(martingaleFactor));
      return;
    }
    const next = clampMartingaleFactor(parsed);
    persistMartingaleFactor(next);
    setMartingaleFactor(next);
    setMartingaleFactorDraft(String(next));
  }, [martingaleFactor]);

  const applyMartingaleReset = useCallback((raw: string) => {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) {
      setMartingaleResetDraft(String(martingaleReset));
      return;
    }
    const next = Math.min(MARTINGALE_RESET_MAX, Math.max(MARTINGALE_RESET_MIN, parsed));
    persistMartingaleReset(next);
    setMartingaleReset(next);
    setMartingaleResetDraft(String(next));
  }, [martingaleReset]);

  const filtered = useMemo(() => {
    const sorted = [...draws].sort((a, b) => b.issue.localeCompare(a.issue));
    if (!search.trim()) return sorted;
    const q = search.trim();
    return sorted.filter((d) => d.issue.includes(q) || d.time.includes(q));
  }, [search, draws]);

  const overview = useMemo(() => {
    const { recs, nextPicks, hasEnough, evaluatedCount } = recommendation;
    const { maxWin, maxLoss } = computeStreaks(draws, recs);
    const hits = draws.filter((d) => recs.get(d.issue)?.eligible && recs.get(d.issue)?.hit).length;
    const hitRate =
      evaluatedCount === 0 ? '—' : `${Math.round((hits / evaluatedCount) * 100)}%`;
    return {
      total: draws.length,
      maxWin: evaluatedCount === 0 ? '—' : maxWin,
      maxLoss: evaluatedCount === 0 ? '—' : maxLoss,
      hitRate,
      evaluatedCount,
      nextPicks: hasEnough ? nextPicks : [],
      hasEnough,
    };
  }, [draws, recommendation]);

  const tabs: { key: TabKey; label: string; icon: typeof Hash }[] = [
    { key: 'table', label: '开奖记录', icon: Hash },
    { key: 'frequency', label: '号码频率', icon: BarChart3 },
    { key: 'trend', label: '走势分析', icon: TrendingUp },
    { key: 'profit', label: '盈亏模拟', icon: Wallet },
    { key: 'autobet', label: '自动投注', icon: Zap },
  ];

  // Show login screen if not logged in
  if (!sessionId) {
    return <LoginScreen onLoginSuccess={handleLoginSuccess} />;
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 via-slate-50 to-sky-50">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/80 backdrop-blur-lg">
        <div className="mx-auto max-w-6xl px-4 py-4 sm:px-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500 to-emerald-500 text-white shadow-md">
                <Award className="h-6 w-6" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-xl font-bold text-slate-900">{gameLabel(gameId)}</h1>
                  <select
                    value={gameId}
                    onChange={(e) => {
                      const next = Number.parseInt(e.target.value, 10);
                      if (isGameId(next)) applyGame(next);
                    }}
                    className="rounded-lg border border-slate-200 bg-white px-2 py-1 text-sm font-medium text-slate-700 shadow-sm outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
                  >
                    {GAMES.map((game) => (
                      <option key={game.id} value={game.id}>
                        {game.label}
                      </option>
                    ))}
                  </select>
                </div>
                <p className="text-sm text-slate-500">
                  {draws.length > 0 ? `已加载 ${draws.length} 期开奖数据` : '正在加载…'}
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 shadow-sm">
                <span className="whitespace-nowrap">统计窗口</span>
                <input
                  type="number"
                  min={WINDOW_MIN}
                  max={WINDOW_MAX}
                  value={windowDraft}
                  onChange={(e) => setWindowDraft(e.target.value)}
                  onBlur={(e) => applyWindowSize(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      applyWindowSize((e.target as HTMLInputElement).value);
                    }
                  }}
                  className="w-16 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-center font-medium text-slate-800 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
                />
                <span className="text-slate-400">期</span>
              </label>
              <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 shadow-sm">
                <span className="whitespace-nowrap">推荐个数</span>
                <input
                  type="number"
                  min={PICK_MIN}
                  max={PICK_MAX}
                  value={pickDraft}
                  onChange={(e) => setPickDraft(e.target.value)}
                  onBlur={(e) => applyPickCount(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      applyPickCount((e.target as HTMLInputElement).value);
                    }
                  }}
                  className="w-16 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-center font-medium text-slate-800 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
                />
                <span className="text-slate-400">码</span>
              </label>
              <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 shadow-sm">
                <span className="whitespace-nowrap">上期号码</span>
                <select
                  value={excludeLast ? 'exclude' : 'include'}
                  onChange={(e) => {
                    const next = e.target.value === 'exclude';
                    persistExcludeLast(next);
                    setExcludeLast(next);
                  }}
                  className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 font-medium text-slate-800 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
                >
                  <option value="include">推荐</option>
                  <option value="exclude">不推荐</option>
                </select>
              </label>
              <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 shadow-sm">
                <span className="whitespace-nowrap">倍投</span>
                <select
                  value={martingaleOn ? 'on' : 'off'}
                  onChange={(e) => {
                    const next = e.target.value === 'on';
                    persistMartingaleOn(next);
                    setMartingaleOn(next);
                  }}
                  className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 font-medium text-slate-800 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
                >
                  <option value="off">关闭</option>
                  <option value="on">开启</option>
                </select>
              </label>
              {martingaleOn && (
                <>
                  <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 shadow-sm">
                    <span className="whitespace-nowrap">倍数</span>
                    <input
                      type="number"
                      min={MARTINGALE_FACTOR_MIN}
                      max={MARTINGALE_FACTOR_MAX}
                      step="0.1"
                      value={martingaleFactorDraft}
                      onChange={(e) => setMartingaleFactorDraft(e.target.value)}
                      onBlur={(e) => applyMartingaleFactor(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          applyMartingaleFactor((e.target as HTMLInputElement).value);
                        }
                      }}
                      className="w-16 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-center font-medium text-slate-800 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
                    />
                  </label>
                  <label className="flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 shadow-sm">
                    <span className="whitespace-nowrap">连不中重计</span>
                    <input
                      type="number"
                      min={MARTINGALE_RESET_MIN}
                      max={MARTINGALE_RESET_MAX}
                      value={martingaleResetDraft}
                      onChange={(e) => setMartingaleResetDraft(e.target.value)}
                      onBlur={(e) => applyMartingaleReset(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          applyMartingaleReset((e.target as HTMLInputElement).value);
                        }
                      }}
                      className="w-14 rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-center font-medium text-slate-800 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
                    />
                    <span className="text-slate-400">次</span>
                  </label>
                </>
              )}
              <button
                onClick={() => fetchDraws(sessionId, gameId)}
                disabled={loadingDraws}
                className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:bg-slate-50 disabled:opacity-50"
              >
                <RefreshCw className={`h-4 w-4 ${loadingDraws ? 'animate-spin' : ''}`} />
                刷新
              </button>
              <button
                onClick={handleLogout}
                className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-600 shadow-sm transition hover:bg-slate-50"
              >
                <LogOut className="h-4 w-4" />
                退出
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        {/* Bet error banner */}
        {betError && (
          <div className="mb-6 flex items-start justify-between gap-3 rounded-xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-600">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 flex-shrink-0" />
              <span>{betError}</span>
            </div>
            <button
              onClick={() => setBetError('')}
              className="flex-shrink-0 text-rose-400 transition hover:text-rose-600"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {/* Loading state */}
        {loadingDraws && draws.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24">
            <Loader2 className="h-10 w-10 animate-spin text-sky-500" />
            <p className="mt-4 text-sm text-slate-500">正在获取实时开奖数据…</p>
          </div>
        )}

        {/* Error state */}
        {drawsError && draws.length === 0 && (
          <div className="flex flex-col items-center justify-center py-24">
            <div className="flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-600">
              <AlertCircle className="h-5 w-5 flex-shrink-0" />
              <span>{drawsError}</span>
            </div>
            <button
              onClick={() => fetchDraws(sessionId, gameId)}
              className="mt-4 inline-flex items-center gap-2 rounded-xl bg-sky-500 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-sky-600"
            >
              <RefreshCw className="h-4 w-4" />
              重新获取
            </button>
          </div>
        )}

        {/* Data display */}
        {draws.length > 0 && (
          <>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <StatCard
                label="总期数"
                value={overview.total}
                sub="本期加载"
                accent="bg-gradient-to-r from-sky-500 to-sky-600"
              />
              <StatCard
                label="最大连胜"
                value={overview.maxWin}
                sub="推荐连续命中"
                accent="bg-gradient-to-r from-emerald-500 to-green-600"
              />
              <StatCard
                label="最大连败"
                value={overview.maxLoss}
                sub="推荐连续未中"
                accent="bg-gradient-to-r from-rose-500 to-orange-500"
              />
              <StatCard
                label="推荐命中率"
                value={overview.hitRate}
                sub={
                  overview.evaluatedCount > 0
                    ? `${pickCount}码个位推荐 · 共 ${overview.evaluatedCount} 期`
                    : `需至少 ${windowSize} 期才能推荐`
                }
                accent="bg-gradient-to-r from-violet-500 to-indigo-600"
              />
            </div>

            {/* Latest draw highlight */}
            <div className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-900 to-slate-800 p-6 text-white shadow-lg">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm text-slate-400">最新一期开奖</p>
                  <p className="mt-1 font-mono text-lg font-semibold text-white">
                    {filtered[0]?.issue ?? ''}
                  </p>
                  <p className="text-sm text-slate-400">{filtered[0]?.time ?? ''}</p>
                </div>
                <div className="flex items-center gap-3">
                  {(filtered[0]?.numbers ?? []).map((n, i) => (
                    <NumberBall key={i} n={n} size="lg" />
                  ))}
                </div>
              </div>
            </div>

            {/* Next draw recommendation */}
            {overview.nextPicks.length > 0 ? (
              <div className="mt-4 overflow-hidden rounded-2xl border border-sky-200 bg-gradient-to-br from-sky-50 to-emerald-50 p-6 shadow-sm">
                <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-medium text-sky-700">本期个位推荐 ({pickCount}码)</p>
                    <p className="mt-1 text-xs text-slate-500">
                      基于最近 {windowSize} 期热号频率 · 转移规律
                      {excludeLast ? ' · 已排除上期个位' : ''}
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {overview.nextPicks.map((n, i) => (
                      <NumberBall key={i} n={n} size="md" />
                    ))}
                  </div>
                </div>
              </div>
            ) : (
              <div className="mt-4 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-800">
                已加载 {overview.total} 期，统计窗口为 {windowSize} 期。记录不足，暂不推荐 {pickCount} 码、不计算盈亏。
              </div>
            )}

            {/* Tabs */}
            <div className="mt-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="inline-flex rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
                {tabs.map(({ key, label, icon: Icon }) => (
                  <button
                    key={key}
                    onClick={() => setTab(key)}
                    className={`inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition ${
                      tab === key
                        ? 'bg-gradient-to-r from-sky-500 to-emerald-500 text-white shadow'
                        : 'text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    <Icon className="h-4 w-4" />
                    {label}
                  </button>
                ))}
              </div>

              {tab === 'table' && (
                <div className="relative">
                  <RefreshCw className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="搜索期号或时间…"
                    className="w-full rounded-xl border border-slate-200 bg-white py-2 pl-10 pr-4 text-sm text-slate-700 shadow-sm outline-none transition focus:border-sky-400 focus:ring-2 focus:ring-sky-100 sm:w-64"
                  />
                </div>
              )}
            </div>

            {/* Content */}
            <div className="mt-6">
              {tab === 'table' && (
                <DataTable data={filtered} recs={recommendation.recs} pickCount={pickCount} />
              )}
              {tab === 'frequency' && <FrequencyChart data={draws} windowSize={windowSize} />}
              {tab === 'trend' && <TrendChart data={draws} />}
              {tab === 'profit' && (
                <ProfitSim
                  data={draws}
                  recs={recommendation.recs}
                  hasEnough={recommendation.hasEnough}
                  windowSize={windowSize}
                  pickCount={pickCount}
                  martingaleOn={martingaleOn}
                  martingaleFactor={martingaleFactor}
                  martingaleReset={martingaleReset}
                />
              )}
              {tab === 'autobet' && (
                <AutoBetPanel
                  sessionId={sessionId ?? ''}
                  gameId={gameId}
                  autoBetOn={autoBetOn}
                  onToggleAutoBet={(on) => {
                    persistAutoBetOn(on);
                    setAutoBetOn(on);
                  }}
                  betAmount={betAmount}
                  onBetAmountChange={(amount) => {
                    persistBetAmount(amount);
                    setBetAmount(amount);
                  }}
                  nextPicks={overview.nextPicks}
                  nextIssue={nextIssue(draws[0]?.issue ?? '')}
                  draws={draws}
                  onPlaceBet={() => {
                    const issue = nextIssue(draws[0]?.issue ?? '');
                    if (issue && overview.nextPicks.length > 0) {
                      placeBet(issue, overview.nextPicks);
                    }
                  }}
                  placingBet={placingBet}
                />
              )}
            </div>

            {/* Disclaimer */}
            <footer className="mt-10 border-t border-slate-200 pt-6 text-center text-xs text-slate-400">
              <p>
                数据来源：实时获取 · 仅供数据展示参考，请理性对待，切勿沉迷
              </p>
            </footer>
          </>
        )}
      </main>
    </div>
  );
}

export default App;
