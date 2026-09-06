import { useState, useCallback, useEffect } from 'react';
import { Zap, Loader2, Trash2, TrendingUp, TrendingDown } from 'lucide-react';
import { API_URL, API_HEADERS } from '@/api';
import { NumberBall, ballColor } from '@/App';

export interface BetRow {
  id: string;
  session_id: string;
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
}

interface AutoBetPanelProps {
  sessionId: string;
  gameId: number;
  autoBetOn: boolean;
  onToggleAutoBet: (on: boolean) => void;
  betAmount: number;
  onBetAmountChange: (amount: number) => void;
  nextPicks: number[];
  nextIssue: string | null;
  draws: { issue: string; numbers: number[] }[];
  onPlaceBet: () => void;
  placingBet: boolean;
}

export function AutoBetPanel({
  sessionId,
  gameId,
  autoBetOn,
  onToggleAutoBet,
  betAmount,
  onBetAmountChange,
  nextPicks,
  nextIssue,
  draws,
  onPlaceBet,
  placingBet,
}: AutoBetPanelProps) {
  const [bets, setBets] = useState<BetRow[]>([]);
  const [loadingBets, setLoadingBets] = useState(false);

  const fetchBets = useCallback(async () => {
    if (!sessionId) return;
    setLoadingBets(true);
    try {
      const resp = await fetch(`${API_URL}?action=betlist`, {
        method: 'POST',
        headers: API_HEADERS,
        body: JSON.stringify({ sessionId, lotteryId: gameId }),
      });
      if (!resp.ok) return;
      const data = await resp.json();
      if (Array.isArray(data.bets)) {
        setBets(data.bets);
      }
    } catch {
      // ignore
    } finally {
      setLoadingBets(false);
    }
  }, [sessionId, gameId]);

  useEffect(() => {
    fetchBets();
  }, [fetchBets]);

  useEffect(() => {
    const interval = setInterval(fetchBets, 10000);
    return () => clearInterval(interval);
  }, [fetchBets]);

  const deleteBet = useCallback(async (betId: string) => {
    try {
      await fetch(`${API_URL}?action=betdelete`, {
        method: 'POST',
        headers: API_HEADERS,
        body: JSON.stringify({ betId }),
      });
      fetchBets();
    } catch {
      // ignore
    }
  }, [fetchBets]);

  const pendingBets = bets.filter((b) => b.status === 'pending');
  const wonBets = bets.filter((b) => b.status === 'won');
  const lostBets = bets.filter((b) => b.status === 'lost');
  const totalCost = bets.reduce((sum, b) => sum + Number(b.total_cost), 0);
  const totalPayout = bets.reduce((sum, b) => sum + Number(b.payout), 0);
  const totalNet = bets.reduce((sum, b) => sum + Number(b.net), 0);
  const winRate = bets.length > 0 && (wonBets.length + lostBets.length) > 0
    ? `${Math.round((wonBets.length / (wonBets.length + lostBets.length)) * 100)}%`
    : '—';

  return (
    <div className="space-y-6">
      {/* Control panel */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-5 flex items-center gap-2">
          <Zap className="h-5 w-5 text-amber-500" />
          <h3 className="text-lg font-semibold text-slate-800">自动投注设置</h3>
        </div>

        <div className="flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-4">
            <label className="flex items-center gap-3">
              <span className="text-sm font-medium text-slate-600">自动投注</span>
              <button
                onClick={() => onToggleAutoBet(!autoBetOn)}
                className={`relative h-7 w-12 rounded-full transition-colors ${
                  autoBetOn ? 'bg-emerald-500' : 'bg-slate-300'
                }`}
              >
                <span
                  className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow transition-transform ${
                    autoBetOn ? 'translate-x-5' : 'translate-x-0.5'
                  }`}
                />
              </button>
              <span className={`text-sm font-medium ${autoBetOn ? 'text-emerald-600' : 'text-slate-400'}`}>
                {autoBetOn ? '已开启' : '已关闭'}
              </span>
            </label>

            <label className="flex items-center gap-2">
              <span className="text-sm font-medium text-slate-600">每码金额</span>
              <input
                type="number"
                min={1}
                step={10}
                value={betAmount}
                onChange={(e) => onBetAmountChange(Number(e.target.value) || 0)}
                className="w-24 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-center font-medium text-slate-800 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
              />
              <span className="text-sm text-slate-400">元</span>
            </label>
          </div>

          <button
            onClick={onPlaceBet}
            disabled={placingBet || !nextIssue || nextPicks.length === 0}
            className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-amber-500 to-orange-500 px-5 py-2.5 text-sm font-medium text-white shadow-sm transition hover:from-amber-600 hover:to-orange-600 disabled:opacity-50"
          >
            {placingBet ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Zap className="h-4 w-4" />
            )}
            手动投注下一期
          </button>
        </div>

        {/* Next bet preview */}
        {autoBetOn && nextIssue && nextPicks.length > 0 && (
          <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium text-amber-800">
                  下一期自动投注: {nextIssue}
                </p>
                <p className="mt-1 text-xs text-amber-600">
                  {nextPicks.length} 码 · 每码 ¥{betAmount} · 共需 ¥{betAmount * nextPicks.length}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {nextPicks.map((n, i) => (
                  <NumberBall key={i} n={n} size="sm" />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-sky-500 to-sky-600" />
          <p className="text-xs font-medium uppercase tracking-wider text-slate-500">总投注</p>
          <p className="mt-2 text-3xl font-bold text-slate-900">{bets.length}</p>
          <p className="mt-1 text-sm text-slate-500">待开奖 {pendingBets.length} 笔</p>
        </div>
        <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-emerald-500 to-green-600" />
          <p className="text-xs font-medium uppercase tracking-wider text-slate-500">命中率</p>
          <p className="mt-2 text-3xl font-bold text-slate-900">{winRate}</p>
          <p className="mt-1 text-sm text-slate-500">中 {wonBets.length} · 未中 {lostBets.length}</p>
        </div>
        <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-amber-500 to-orange-500" />
          <p className="text-xs font-medium uppercase tracking-wider text-slate-500">总投入</p>
          <p className="mt-2 text-3xl font-bold text-slate-900">¥{totalCost.toFixed(2)}</p>
          <p className="mt-1 text-sm text-slate-500">总回报 ¥{totalPayout.toFixed(2)}</p>
        </div>
        <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className={`absolute inset-x-0 top-0 h-1 ${totalNet >= 0 ? 'bg-gradient-to-r from-emerald-500 to-green-600' : 'bg-gradient-to-r from-rose-500 to-orange-500'}`} />
          <p className="text-xs font-medium uppercase tracking-wider text-slate-500">净盈亏</p>
          <p className={`mt-2 text-3xl font-bold ${totalNet >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
            {totalNet >= 0 ? '+' : ''}¥{totalNet.toFixed(2)}
          </p>
          <p className="mt-1 text-sm text-slate-500">
            {totalNet >= 0 ? '盈利' : '亏损'}
          </p>
        </div>
      </div>

      {/* Bet history table */}
      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <h3 className="text-sm font-semibold text-slate-700">投注记录</h3>
          <button
            onClick={fetchBets}
            disabled={loadingBets}
            className="text-xs text-slate-500 hover:text-sky-600 disabled:opacity-50"
          >
            {loadingBets ? '刷新中…' : '刷新'}
          </button>
        </div>
        <div className="max-h-[500px] overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-slate-50 backdrop-blur">
              <tr className="text-left text-slate-600">
                <th className="px-4 py-3 font-semibold">期号</th>
                <th className="px-4 py-3 font-semibold">投注号码</th>
                <th className="px-4 py-3 font-semibold">开奖号</th>
                <th className="px-4 py-3 font-semibold">状态</th>
                <th className="px-4 py-3 font-semibold text-right">投入</th>
                <th className="px-4 py-3 font-semibold text-right">回报</th>
                <th className="px-4 py-3 font-semibold text-right">盈亏</th>
                <th className="px-4 py-3 font-semibold text-right">操作</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {bets.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-slate-400">
                    暂无投注记录
                  </td>
                </tr>
              ) : (
                bets.map((bet) => (
                  <tr key={bet.id} className="transition hover:bg-sky-50/60">
                    <td className="px-4 py-3 font-mono text-slate-700">{bet.issue}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {bet.picks.map((n, i) => (
                          <span
                            key={i}
                            className={`inline-flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ring-1 ${
                              bet.result_number !== null && n === bet.result_number
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
                      {bet.result_number !== null ? (
                        <span className={`inline-flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br ${ballColor(bet.result_number)} text-xs font-bold text-white shadow-sm ring-2 ring-white/40`}>
                          {bet.result_number}
                        </span>
                      ) : (
                        <span className="text-xs text-slate-400">待开奖</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {bet.status === 'pending' ? (
                        <span className="inline-flex rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-700">
                          待开奖
                        </span>
                      ) : bet.status === 'won' ? (
                        <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
                          <TrendingUp className="h-3 w-3" /> 中奖
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2.5 py-0.5 text-xs font-medium text-rose-600">
                          <TrendingDown className="h-3 w-3" /> 未中
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-slate-600">¥{Number(bet.total_cost).toFixed(2)}</td>
                    <td className="px-4 py-3 text-right text-slate-600">¥{Number(bet.payout).toFixed(2)}</td>
                    <td className={`px-4 py-3 text-right font-semibold ${Number(bet.net) >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                      {Number(bet.net) >= 0 ? '+' : ''}¥{Number(bet.net).toFixed(2)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      {bet.status === 'pending' && (
                        <button
                          onClick={() => deleteBet(bet.id)}
                          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-rose-500 transition hover:bg-rose-50"
                        >
                          <Trash2 className="h-3 w-3" />
                          撤销
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
