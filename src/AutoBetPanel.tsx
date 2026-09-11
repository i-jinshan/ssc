import { useState, useCallback, useEffect, useMemo } from 'react';
import { Zap, Loader2, Trash2, TrendingUp, TrendingDown, X, User, Lock, ShieldCheck, RefreshCw, AlertCircle, Eye, EyeOff, CheckCircle2, ArrowRight, ArrowLeft, Wallet, CalendarDays, ChevronDown, ChevronUp } from 'lucide-react';
import { API_URL, API_HEADERS } from '@/api';
import { NumberBall, ballColor, compareBetHistory, nextMartingaleState, stakeWithMultiplier } from '@/App';

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
  position: number;
  remote_ids?: string[];
}

export type BetPlatform = 'aoshi' | 'xingyi';

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
  positionLabel: string;
  onPlaceBet: () => void;
  placingBet: boolean;
  scheduledBetAt: number | null;
  autoBetError?: string;
  martingaleOn: boolean;
  martingaleFactor: number;
  martingaleReset: number;
  platform: BetPlatform;
  onPlatformChange: (platform: BetPlatform) => void;
  xySessionId: string | null;
  onXyLoginSuccess: (sessionId: string) => void;
  onXyLogout: () => void;
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
  positionLabel,
  onPlaceBet,
  placingBet,
  scheduledBetAt,
  autoBetError,
  martingaleOn,
  martingaleFactor,
  martingaleReset,
  platform,
  onPlatformChange,
  xySessionId,
  onXyLoginSuccess,
  onXyLogout,
}: AutoBetPanelProps) {
  const [bets, setBets] = useState<BetRow[]>([]);
  const [loadingBets, setLoadingBets] = useState(false);
  const [showXyLogin, setShowXyLogin] = useState(false);
  const [xyBalance, setXyBalance] = useState<number | null>(null);
  const [xyBalanceError, setXyBalanceError] = useState('');
  const [loadingBalance, setLoadingBalance] = useState(false);
  const [cancelError, setCancelError] = useState('');
  const [daysOpen, setDaysOpen] = useState(false);
  const [showClearDays, setShowClearDays] = useState(false);
  const [clearPassword, setClearPassword] = useState('');
  const [clearError, setClearError] = useState('');
  const [clearingDays, setClearingDays] = useState(false);
  const [days, setDays] = useState<Array<{
    date: string;
    dateLabel: string;
    turnover: number;
    net: number;
    rebate: number;
    wins: number;
    losses: number;
    pending: number;
    winRate: number | null;
  }>>([]);

  const bettingSessionId = platform === 'xingyi' ? xySessionId : sessionId;

  const fetchDays = useCallback(async () => {
    try {
      const resp = await fetch(`${API_URL}?action=betdays`, {
        method: 'POST',
        headers: API_HEADERS,
        body: '{}',
      });
      if (!resp.ok) return;
      const data = await resp.json() as { days?: typeof days };
      if (Array.isArray(data.days)) setDays(data.days);
    } catch {
      // ignore
    }
  }, []);

  const clearHistory = useCallback(async () => {
    if (clearingDays) return;
    setClearingDays(true);
    setClearError('');
    try {
      const resp = await fetch(`${API_URL}?action=betdays-clear`, {
        method: 'POST',
        headers: API_HEADERS,
        body: JSON.stringify({ password: clearPassword }),
      });
      const data = await resp.json() as { success?: boolean; error?: string };
      if (!resp.ok || data.error) {
        setClearError(data.error || '密码错误，无法清空');
        return;
      }
      setDays([]);
      setBets([]);
      setShowClearDays(false);
      setClearPassword('');
    } catch {
      setClearError('清空失败，请检查本地服务');
    } finally {
      setClearingDays(false);
    }
  }, [clearPassword, clearingDays]);

  const fetchBets = useCallback(async () => {
    if (!sessionId && !bettingSessionId) return;
    setLoadingBets(true);
    try {
      const resp = await fetch(`${API_URL}?action=betlist`, {
        method: 'POST',
        headers: API_HEADERS,
        body: JSON.stringify({ sessionId: bettingSessionId || sessionId, lotteryId: gameId }),
      });
      if (!resp.ok) return;
      const data = await resp.json();
      if (Array.isArray(data.bets)) {
        setBets(data.bets);
      }
      void fetchDays();
    } catch {
      // ignore
    } finally {
      setLoadingBets(false);
    }
  }, [bettingSessionId, sessionId, gameId, fetchDays]);

  useEffect(() => {
    fetchBets();
    fetchDays();
  }, [fetchBets, fetchDays]);

  useEffect(() => {
    if (!bettingSessionId || draws.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        await fetch(`${API_URL}?action=betsettle`, {
          method: 'POST',
          headers: API_HEADERS,
          body: JSON.stringify({
            sessionId: bettingSessionId,
            draws: draws.map((d) => ({ issue: d.issue, numbers: d.numbers })),
          }),
        });
      } catch {
        // ignore
      }
      if (!cancelled) fetchBets();
    })();
    return () => {
      cancelled = true;
    };
  }, [bettingSessionId, draws, fetchBets]);

  useEffect(() => {
    const interval = setInterval(fetchBets, 10000);
    return () => clearInterval(interval);
  }, [fetchBets]);

  useEffect(() => {
    if (!placingBet) fetchBets();
  }, [placingBet, fetchBets]);

  const fetchXyBalance = useCallback(async () => {
    if (platform !== 'xingyi' || !xySessionId) {
      setXyBalance(null);
      setXyBalanceError('');
      return;
    }
    setLoadingBalance(true);
    try {
      const resp = await fetch(`${API_URL}?action=xybalance`, {
        method: 'POST',
        headers: API_HEADERS,
        body: JSON.stringify({ sessionId: xySessionId }),
      });
      const data = await resp.json();
      if (typeof data.balance === 'number' && Number.isFinite(data.balance)) {
        setXyBalance(data.balance);
        setXyBalanceError('');
      } else {
        setXyBalance(null);
        setXyBalanceError(data.error || '未能读取余额');
      }
    } catch {
      setXyBalance(null);
      setXyBalanceError('读取余额失败');
    } finally {
      setLoadingBalance(false);
    }
  }, [platform, xySessionId]);

  useEffect(() => {
    fetchXyBalance();
    if (platform !== 'xingyi' || !xySessionId) return;
    const interval = setInterval(fetchXyBalance, 30000);
    return () => clearInterval(interval);
  }, [fetchXyBalance, platform, xySessionId]);

  const deleteBet = useCallback(async (betId: string) => {
    if (!bettingSessionId) return;
    setCancelError('');
    try {
      const resp = await fetch(`${API_URL}?action=betdelete`, {
        method: 'POST',
        headers: API_HEADERS,
        body: JSON.stringify({ betId, sessionId: bettingSessionId }),
      });
      const data = await resp.json() as { success?: boolean; error?: string };
      if (!resp.ok || data.error) {
        setCancelError(data.error || '撤单失败');
        return;
      }
      fetchBets();
      if (platform === 'xingyi') fetchXyBalance();
    } catch {
      setCancelError('撤单请求失败，请检查网络连接');
    }
  }, [bettingSessionId, fetchBets, fetchXyBalance, platform]);

  const pendingBets = bets.filter((b) => b.status === 'pending');
  const wonBets = bets.filter((b) => b.status === 'won');
  const lostBets = bets.filter((b) => b.status === 'lost');
  const totalCost = bets.reduce((sum, b) => sum + Number(b.total_cost), 0);
  const totalPayout = bets.reduce((sum, b) => sum + Number(b.payout), 0);
  const totalNet = bets.reduce((sum, b) => sum + Number(b.net), 0);
  const winRate = bets.length > 0 && (wonBets.length + lostBets.length) > 0
    ? `${Math.round((wonBets.length / (wonBets.length + lostBets.length)) * 100)}%`
    : '—';

  const martingale = useMemo(() => {
    const results = [...bets]
      .filter((bet) => bet.status === 'won' || bet.status === 'lost')
      .sort(compareBetHistory)
      .map((bet) => bet.status as 'won' | 'lost');
    return nextMartingaleState(results, martingaleOn, martingaleFactor, martingaleReset);
  }, [bets, martingaleOn, martingaleFactor, martingaleReset]);
  const stakePerNumber = stakeWithMultiplier(betAmount, martingale.multiplier);
  const stakeTotal = stakePerNumber * nextPicks.length;

  const needsXyLogin = platform === 'xingyi' && !xySessionId;

  const handlePlatformChange = (next: BetPlatform) => {
    onPlatformChange(next);
    if (next === 'xingyi' && !xySessionId) {
      setShowXyLogin(true);
    }
  };

  const handlePlaceBet = () => {
    if (platform === 'xingyi' && !xySessionId) {
      setShowXyLogin(true);
      return;
    }
    onPlaceBet();
  };

  return (
    <div className="space-y-6">
      {/* Control panel */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="mb-5 flex items-center gap-2">
          <Zap className="h-5 w-5 text-amber-500" />
          <h3 className="text-lg font-semibold text-slate-800">自动投注设置</h3>
        </div>

        {/* Platform selector */}
        <div className="mb-5">
          <label className="mb-2 block text-sm font-medium text-slate-600">投注平台</label>
          <div className="flex flex-wrap gap-3">
            <button
              onClick={() => handlePlatformChange('aoshi')}
              className={`flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-medium transition ${
                platform === 'aoshi'
                  ? 'border-sky-400 bg-sky-50 text-sky-700 shadow-sm'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
              }`}
            >
              <span className={`h-2.5 w-2.5 rounded-full ${platform === 'aoshi' ? 'bg-sky-500' : 'bg-slate-300'}`} />
              傲世皇朝
            </button>
            <button
              onClick={() => handlePlatformChange('xingyi')}
              className={`flex items-center gap-2 rounded-xl border px-4 py-2.5 text-sm font-medium transition ${
                platform === 'xingyi'
                  ? 'border-emerald-400 bg-emerald-50 text-emerald-700 shadow-sm'
                  : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'
              }`}
            >
              <span className={`h-2.5 w-2.5 rounded-full ${platform === 'xingyi' ? 'bg-emerald-500' : 'bg-slate-300'}`} />
              星亿娱乐
            </button>
          </div>
          {platform === 'xingyi' && (
            <p className="mt-2 text-xs text-slate-500">
              当前投注星亿 {gameId === 60 ? '腾讯分分彩' : gameId === 127 ? '腾讯5分彩' : '腾讯10分彩'}
              （s.xybet00.com/Bet/{gameId}）
            </p>
          )}
          {platform === 'xingyi' && (
            <div className="mt-3 flex items-center gap-3">
              {xySessionId ? (
                <div className="flex items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-100 px-3 py-1.5 text-xs font-medium text-emerald-700">
                    <span className="h-2 w-2 rounded-full bg-emerald-500" />
                    星亿娱乐已登录
                  </span>
                  <button
                    onClick={onXyLogout}
                    className="text-xs text-slate-500 hover:text-rose-500"
                  >
                    退出登录
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setShowXyLogin(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-emerald-600"
                >
                  登录星亿娱乐
                </button>
              )}
            </div>
          )}
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
                {autoBetOn ? '已开启（后台运行）' : '已关闭'}
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
            onClick={handlePlaceBet}
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

        {autoBetOn && (
          <p className="mt-3 text-xs leading-5 text-slate-500">
            自动投注在本机服务里运行，关掉网页也会继续下。关机、休眠，或关掉跑项目的终端（npm run dev / npm start）后会停止。下次在本页关掉开关即可停止。
          </p>
        )}
        {autoBetError && autoBetOn && (
          <div className="mt-3 flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span>{autoBetError}</span>
          </div>
        )}
        {needsXyLogin && autoBetOn && (
          <div className="mt-4 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span>请先登录星亿娱乐，才能进行自动投注</span>
          </div>
        )}

        {/* Next bet preview */}
        {autoBetOn && nextIssue && nextPicks.length > 0 && !(platform === 'xingyi' && !xySessionId) && (
          <div className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-medium text-amber-800">
                  下一期{positionLabel}自动投注: {nextIssue}
                </p>
                <p className="mt-1 text-xs text-amber-600">
                  {nextPicks.length} 码 · 每码 ¥{stakePerNumber}
                  {martingaleOn ? ` · ${martingale.multiplier}倍` : ''}
                  · 共需 ¥{stakeTotal}
                  {martingaleOn ? ` · 连不中 ${martingale.lossStreak}/${martingaleReset}` : ''}
                  {platform === 'xingyi' ? ' · 星亿娱乐' : ' · 傲世皇朝'}
                  {placingBet ? ' · 正在提交投注…' : scheduledBetAt ? ` · 随机等待至 ${new Date(scheduledBetAt).toLocaleTimeString('zh-CN', { hour12: false })} 再投` : ''}
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

      {platform === 'xingyi' && xySessionId && (
        <div className="flex items-center justify-between rounded-2xl border border-emerald-200 bg-white px-5 py-4 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-50 text-emerald-600">
              <Wallet className="h-5 w-5" />
            </div>
            <div>
              <p className="text-xs font-medium uppercase tracking-wider text-slate-400">星亿娱乐账户余额</p>
              <p className="mt-1 text-2xl font-bold text-slate-900">
                {xyBalance == null ? '—' : `¥${xyBalance.toFixed(3)}`}
              </p>
              {xyBalanceError && (
                <p className="mt-0.5 text-xs text-rose-500">{xyBalanceError}</p>
              )}
            </div>
          </div>
          <button
            onClick={fetchXyBalance}
            disabled={loadingBalance}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loadingBalance ? 'animate-spin' : ''}`} />
            刷新余额
          </button>
        </div>
      )}

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

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
        <div className={`flex items-center justify-between px-5 py-3 ${daysOpen ? 'border-b border-slate-100' : ''}`}>
          <div className="flex items-center gap-2">
            <CalendarDays className="h-4 w-4 text-sky-500" />
            <h3 className="text-sm font-semibold text-slate-700">每日投注汇总</h3>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setShowClearDays(true);
                setClearPassword('');
                setClearError('');
              }}
              className="rounded-lg border border-rose-200 px-2.5 py-1 text-xs font-medium text-rose-600 transition hover:bg-rose-50"
            >
              清空历史数据
            </button>
            <button
              type="button"
              onClick={() => setDaysOpen((open) => !open)}
              className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-500 transition hover:bg-slate-100 hover:text-slate-800"
              aria-label={daysOpen ? '收起每日汇总' : '展开每日汇总'}
            >
              {daysOpen ? <ChevronUp className="h-5 w-5" /> : <ChevronDown className="h-5 w-5" />}
            </button>
          </div>
        </div>
        {daysOpen && (
          <div className="max-h-[360px] overflow-auto">
            <p className="px-5 pt-3 text-xs text-slate-400">北京时间 · 流水每万返 475 · 关机后仍保留</p>
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-slate-50">
                <tr className="text-left text-slate-600">
                  <th className="px-4 py-3 font-semibold">日期</th>
                  <th className="px-4 py-3 font-semibold text-right">总投注量</th>
                  <th className="px-4 py-3 font-semibold text-right">输赢</th>
                  <th className="px-4 py-3 font-semibold text-right">流水奖励</th>
                  <th className="px-4 py-3 font-semibold text-right">含奖励</th>
                  <th className="px-4 py-3 font-semibold text-right">胜率</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {days.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-slate-400">
                      暂无每日汇总，投注成功后会写入本地记录
                    </td>
                  </tr>
                ) : (
                  days.map((row) => {
                    const withRebate = row.net + row.rebate;
                    return (
                      <tr key={row.date} className="transition hover:bg-sky-50/60">
                        <td className="px-4 py-3 font-medium text-slate-800">{row.dateLabel}</td>
                        <td className="px-4 py-3 text-right tabular-nums text-slate-700">¥{row.turnover.toFixed(2)}</td>
                        <td className={`px-4 py-3 text-right tabular-nums font-medium ${row.net >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                          {row.net >= 0 ? '+' : ''}¥{row.net.toFixed(2)}
                        </td>
                        <td className="px-4 py-3 text-right tabular-nums text-amber-600">+¥{row.rebate.toFixed(2)}</td>
                        <td className={`px-4 py-3 text-right tabular-nums font-medium ${withRebate >= 0 ? 'text-emerald-600' : 'text-rose-600'}`}>
                          {withRebate >= 0 ? '+' : ''}¥{withRebate.toFixed(2)}
                        </td>
                        <td className="px-4 py-3 text-right text-slate-700">
                          {row.winRate == null ? '—' : `${Math.round(row.winRate * 1000) / 10}%`}
                          <span className="ml-1 text-xs text-slate-400">
                            {row.wins}/{row.wins + row.losses}
                            {row.pending > 0 ? ` · 待开${row.pending}` : ''}
                          </span>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showClearDays && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 px-4 backdrop-blur-sm">
          <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-xl">
            <h3 className="text-base font-semibold text-slate-900">清空历史数据</h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              将删除本机保存的每日汇总和投注记录，且不可恢复。请输入密码确认。
            </p>
            <input
              type="password"
              value={clearPassword}
              onChange={(e) => setClearPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void clearHistory();
              }}
              placeholder="请输入密码"
              className="mt-4 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-800 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-100"
            />
            {clearError && (
              <p className="mt-2 text-sm text-rose-600">{clearError}</p>
            )}
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setShowClearDays(false);
                  setClearPassword('');
                  setClearError('');
                }}
                className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void clearHistory()}
                disabled={clearingDays || !clearPassword}
                className="rounded-xl bg-rose-500 px-4 py-2 text-sm font-medium text-white hover:bg-rose-600 disabled:opacity-50"
              >
                {clearingDays ? '清空中…' : '确认清空'}
              </button>
            </div>
          </div>
        </div>
      )}

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
        {cancelError && (
          <div className="mx-5 mt-3 mb-1 flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-600">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span>{cancelError}</span>
          </div>
        )}
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

      {/* 星亿娱乐 login modal */}
      {showXyLogin && (
        <XyLoginModal
          onClose={() => setShowXyLogin(false)}
          onSuccess={(sid) => {
            onXyLoginSuccess(sid);
            setShowXyLogin(false);
          }}
        />
      )}
    </div>
  );
}

// ── 星亿娱乐 login modal ──

interface XyLoginModalProps {
  onClose: () => void;
  onSuccess: (sessionId: string) => void;
}

function XyLoginModal({ onClose, onSuccess }: XyLoginModalProps) {
  const [step, setStep] = useState<1 | 2>(1);
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [captchaInput, setCaptchaInput] = useState('');
  const [captchaImage, setCaptchaImage] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [greeting, setGreeting] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingCaptcha, setLoadingCaptcha] = useState(false);
  const [error, setError] = useState('');
  const [imgError, setImgError] = useState(false);

  const fetchCaptcha = useCallback(async () => {
    setLoadingCaptcha(true);
    setError('');
    setCaptchaInput('');
    setImgError(false);
    try {
      const resp = await fetch(`${API_URL}?action=xycaptcha`, {
        headers: API_HEADERS,
        signal: AbortSignal.timeout(20000),
      });
      const data = (await resp.json().catch(() => ({}))) as {
        error?: string; captchaImage?: string; sessionId?: string;
      };
      if (!resp.ok || data.error || !data.captchaImage || !data.sessionId) {
        throw new Error(data.error || `获取验证码失败 (${resp.status})`);
      }
      setCaptchaImage(data.captchaImage);
      setSessionId(data.sessionId);
    } catch (err) {
      const msg = err instanceof Error
        ? (err.name === 'TimeoutError' ? '获取验证码超时，请重试' : err.message)
        : '获取星亿娱乐验证码失败';
      setError(msg);
    } finally {
      setLoadingCaptcha(false);
    }
  }, []);

  useEffect(() => {
    fetchCaptcha();
  }, [fetchCaptcha]);

  // Step 1: submit username + captcha → get greeting
  const handleStep1 = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loginId.trim() || !captchaInput.trim()) {
      setError('请填写帐号和验证码');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const resp = await fetch(`${API_URL}?action=xystep1`, {
        method: 'POST',
        headers: API_HEADERS,
        body: JSON.stringify({
          sessionId,
          loginId: loginId.trim(),
          captchaInput: captchaInput.trim(),
        }),
      });
      const data = await resp.json();
      if (data.success) {
        setGreeting(data.greeting || '请确认问候语');
        setStep(2);
      } else {
        setError(data.error || '验证失败');
        fetchCaptcha();
      }
    } catch {
      setError('网络错误，请重试');
      fetchCaptcha();
    } finally {
      setLoading(false);
    }
  };

  // Step 2: submit password → complete login
  const handleStep2 = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) {
      setError('请输入密码');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const resp = await fetch(`${API_URL}?action=xystep2`, {
        method: 'POST',
        headers: API_HEADERS,
        body: JSON.stringify({
          sessionId,
          password: password.trim(),
        }),
      });
      const data = await resp.json();
      if (data.success) {
        onSuccess(data.sessionId);
      } else {
        setError(data.error || '登录失败');
      }
    } catch {
      setError('网络错误，请重试');
    } finally {
      setLoading(false);
    }
  };

  const backToStep1 = () => {
    setStep(1);
    setPassword('');
    setError('');
    setGreeting('');
    fetchCaptcha();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="relative w-full max-w-md rounded-2xl border border-slate-200 bg-white p-8 shadow-2xl">
        <button
          onClick={onClose}
          className="absolute right-4 top-4 text-slate-400 transition hover:text-slate-600"
        >
          <X className="h-5 w-5" />
        </button>

        <div className="mb-6 text-center">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-500 shadow-lg">
            <ShieldCheck className="h-7 w-7 text-white" />
          </div>
          <h2 className="text-xl font-bold text-slate-800">登录星亿娱乐</h2>
          <p className="mt-1 text-sm text-slate-500">
            {step === 1 ? '第一步：输入帐号和验证码' : '第二步：确认问候语并输入密码'}
          </p>
        </div>

        {/* Step indicator */}
        <div className="mb-6 flex items-center justify-center gap-2">
          <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${step === 1 ? 'bg-emerald-500 text-white' : 'bg-emerald-100 text-emerald-600'}`}>
            {step === 1 ? '1' : <CheckCircle2 className="h-4 w-4" />}
          </div>
          <div className={`h-1 w-12 rounded ${step === 2 ? 'bg-emerald-400' : 'bg-slate-200'}`} />
          <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${step === 2 ? 'bg-emerald-500 text-white' : 'bg-slate-200 text-slate-400'}`}>
            2
          </div>
        </div>

        {error && (
          <div className="mb-5 flex items-center gap-2 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-600">
            <AlertCircle className="h-4 w-4 flex-shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Step 1: username + captcha */}
        {step === 1 && (
          <form onSubmit={handleStep1} className="space-y-5">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-600">帐号</label>
              <div className="relative">
                <User className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  value={loginId}
                  onChange={(e) => setLoginId(e.target.value)}
                  placeholder="请输入星亿娱乐帐号"
                  autoComplete="username"
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 py-3 pl-11 pr-4 text-slate-800 placeholder-slate-400 outline-none transition focus:border-emerald-400 focus:bg-white focus:ring-2 focus:ring-emerald-100"
                />
              </div>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-600">验证码</label>
              <div className="flex gap-3">
                <div className="relative flex-1">
                  <ShieldCheck className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    value={captchaInput}
                    onChange={(e) => setCaptchaInput(e.target.value)}
                    placeholder="请输入验证码"
                    maxLength={6}
                    className="w-full rounded-xl border border-slate-200 bg-slate-50 py-3 pl-11 pr-4 text-slate-800 placeholder-slate-400 outline-none transition focus:border-emerald-400 focus:bg-white focus:ring-2 focus:ring-emerald-100"
                  />
                </div>
                <button
                  type="button"
                  onClick={fetchCaptcha}
                  disabled={loadingCaptcha}
                  className="relative h-[46px] w-32 flex-shrink-0 overflow-hidden rounded-xl border border-slate-200 bg-slate-50 transition hover:border-emerald-300 disabled:opacity-50"
                  title="点击刷新验证码"
                >
                  {loadingCaptcha ? (
                    <div className="flex h-full items-center justify-center">
                      <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
                    </div>
                  ) : captchaImage && !imgError ? (
                    <img
                      src={captchaImage}
                      alt="验证码"
                      className="h-full w-full object-cover"
                      onError={() => {
                        setImgError(true);
                        setError('验证码图片加载失败，正在重试…');
                        setTimeout(() => fetchCaptcha(), 1500);
                      }}
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-slate-400">
                      <RefreshCw className="h-5 w-5" />
                    </div>
                  )}
                </button>
              </div>
            </div>
            <button
              type="submit"
              disabled={loading || loadingCaptcha}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 py-3 font-semibold text-white shadow-lg shadow-emerald-500/20 transition hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin" />
                  验证中…
                </>
              ) : (
                <>
                  下一步
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </button>
          </form>
        )}

        {/* Step 2: greeting confirmation + password */}
        {step === 2 && (
          <form onSubmit={handleStep2} className="space-y-5">
            {/* Greeting display */}
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="mt-0.5 h-5 w-5 flex-shrink-0 text-emerald-500" />
                <div>
                  <p className="text-sm font-medium text-emerald-800">问候语确认</p>
                  <p className="mt-1 text-lg font-semibold text-emerald-700">{greeting}</p>
                  <p className="mt-1 text-xs text-emerald-600">请确认以上问候语是否正确，然后输入密码完成登录</p>
                </div>
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-600">密码</label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-400" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="请输入密码"
                  autoComplete="current-password"
                  autoFocus
                  className="w-full rounded-xl border border-slate-200 bg-slate-50 py-3 pl-11 pr-11 text-slate-800 placeholder-slate-400 outline-none transition focus:border-emerald-400 focus:bg-white focus:ring-2 focus:ring-emerald-100"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-400 transition hover:text-slate-600"
                >
                  {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                </button>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                type="button"
                onClick={backToStep1}
                disabled={loading}
                className="flex items-center justify-center gap-1.5 rounded-xl border border-slate-200 px-4 py-3 text-sm font-medium text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
              >
                <ArrowLeft className="h-4 w-4" />
                返回
              </button>
              <button
                type="submit"
                disabled={loading}
                className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 py-3 font-semibold text-white shadow-lg shadow-emerald-500/20 transition hover:shadow-xl disabled:cursor-not-allowed disabled:opacity-50"
              >
                {loading ? (
                  <>
                    <Loader2 className="h-5 w-5 animate-spin" />
                    登录中…
                  </>
                ) : (
                  '确认登录'
                )}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
