import { Fragment, useCallback, useEffect, useState } from 'react';
import { Award, Bell, ChevronDown, ChevronUp, KeyRound, Loader2, LogOut, Pencil, Plus, Shield, Trash2 } from 'lucide-react';
import { API_URL, API_HEADERS } from '@/api';

type DayRow = {
  date: string;
  dateLabel: string;
  turnover: number;
  net: number;
  rebate: number;
  wins: number;
  losses: number;
  pending: number;
  winRate: number | null;
};

type TotalsRow = {
  turnover: number;
  net: number;
  rebate: number;
  wins: number;
  losses: number;
  pending: number;
  winRate: number | null;
};

type MemberRow = {
  id: string;
  aoshiLoginId: string;
  xyLoginId: string;
  createdAt: string;
  days?: DayRow[];
  totals?: TotalsRow;
};

const TOKEN_KEY = 'ssc-admin-token';

function formatAddedAt(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Date(ms).toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour12: false,
  });
}

function beijingToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

function money(value: number, signed = false): string {
  const prefix = signed ? (value > 0 ? '+' : '') : '';
  return `${prefix}¥${value.toFixed(2)}`;
}

function moneyClass(value: number): string {
  if (value > 0) return 'text-emerald-400';
  if (value < 0) return 'text-rose-400';
  return 'text-slate-300';
}

function winRateText(row: { winRate: number | null; wins: number; losses: number; pending: number }): string {
  const rate = row.winRate == null ? '—' : `${Math.round(row.winRate * 1000) / 10}%`;
  const pending = row.pending > 0 ? ` · 待开${row.pending}` : '';
  return `${rate} ${row.wins}/${row.wins + row.losses}${pending}`;
}

export function AdminApp() {
  const [token, setToken] = useState(() => {
    try {
      return localStorage.getItem(TOKEN_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [currentAdminUser, setCurrentAdminUser] = useState('admin');
  const [newUsername, setNewUsername] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [aoshiLoginId, setAoshiLoginId] = useState('');
  const [xyLoginId, setXyLoginId] = useState('');
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [openMemberId, setOpenMemberId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editAoshi, setEditAoshi] = useState('');
  const [editXy, setEditXy] = useState('');
  const [error, setError] = useState('');
  const [accountError, setAccountError] = useState('');
  const [accountOk, setAccountOk] = useState('');
  const [loading, setLoading] = useState(false);
  const [savingAccount, setSavingAccount] = useState(false);
  const [botToken, setBotToken] = useState('');
  const [botConfigured, setBotConfigured] = useState(false);
  const [botMasked, setBotMasked] = useState('');
  const [botUsername, setBotUsername] = useState('');
  const [botError, setBotError] = useState('');
  const [botOk, setBotOk] = useState('');
  const [botApiBase, setBotApiBase] = useState('');
  const [savingBot, setSavingBot] = useState(false);

  const persistToken = (value: string) => {
    setToken(value);
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      // ignore
    }
  };

  const loadTelegramAdmin = useCallback(async (adminToken: string) => {
    const resp = await fetch(`${API_URL}?action=telegram-admin-status`, {
      method: 'POST',
      headers: API_HEADERS,
      body: JSON.stringify({ adminToken }),
    });
    const data = await resp.json() as {
      configured?: boolean;
      tokenMasked?: string;
      botUsername?: string;
      apiBase?: string;
    };
    if (!resp.ok) return;
    setBotConfigured(Boolean(data.configured));
    setBotMasked(data.tokenMasked || '');
    setBotUsername(data.botUsername || '');
    setBotApiBase(data.apiBase || '');
  }, []);

  const loadMembers = useCallback(async (adminToken: string) => {
    const resp = await fetch(`${API_URL}?action=members-list`, {
      method: 'POST',
      headers: API_HEADERS,
      body: JSON.stringify({ adminToken }),
    });
    const data = await resp.json() as { members?: MemberRow[]; username?: string; error?: string };
    if (!resp.ok || data.error) {
      persistToken('');
      throw new Error(data.error || '后台登录已过期');
    }
    setMembers(Array.isArray(data.members) ? data.members : []);
    if (data.username) {
      setCurrentAdminUser(data.username);
      setNewUsername((prev) => prev || data.username || '');
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    void loadMembers(token).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : '加载失败');
    });
    void loadTelegramAdmin(token);
  }, [token, loadMembers, loadTelegramAdmin]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      const resp = await fetch(`${API_URL}?action=admin-login`, {
        method: 'POST',
        headers: API_HEADERS,
        body: JSON.stringify({ username, password }),
      });
      const data = await resp.json() as { adminToken?: string; username?: string; error?: string };
      if (!resp.ok || !data.adminToken) throw new Error(data.error || '登录失败');
      persistToken(data.adminToken);
      setCurrentAdminUser(data.username || username);
      setNewUsername(data.username || username);
      setPassword('');
      await loadMembers(data.adminToken);
      await loadTelegramAdmin(data.adminToken);
    } catch (err) {
      setError(err instanceof Error ? err.message : '登录失败');
    } finally {
      setLoading(false);
    }
  };

  const handleAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    setLoading(true);
    setError('');
    try {
      const resp = await fetch(`${API_URL}?action=members-add`, {
        method: 'POST',
        headers: API_HEADERS,
        body: JSON.stringify({ adminToken: token, aoshiLoginId, xyLoginId }),
      });
      const data = await resp.json() as { members?: MemberRow[]; error?: string };
      if (!resp.ok || data.error) throw new Error(data.error || '添加失败');
      setAoshiLoginId('');
      setXyLoginId('');
      await loadMembers(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加失败');
    } finally {
      setLoading(false);
    }
  };

  const handleUpdate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !editingId) return;
    setLoading(true);
    setError('');
    try {
      const resp = await fetch(`${API_URL}?action=members-update`, {
        method: 'POST',
        headers: API_HEADERS,
        body: JSON.stringify({
          adminToken: token,
          id: editingId,
          aoshiLoginId: editAoshi,
          xyLoginId: editXy,
        }),
      });
      const data = await resp.json() as { error?: string };
      if (!resp.ok || data.error) throw new Error(data.error || '保存失败');
      setEditingId(null);
      await loadMembers(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setLoading(false);
    }
  };

  const startEdit = (row: MemberRow) => {
    setEditingId(row.id);
    setEditAoshi(row.aoshiLoginId);
    setEditXy(row.xyLoginId ?? '');
    setError('');
  };

  const handleDelete = async (id: string) => {
    if (!token) return;
    if (!window.confirm('删除后该会员将无法使用推荐和自动投注，确定删除？')) return;
    setLoading(true);
    setError('');
    try {
      const resp = await fetch(`${API_URL}?action=members-delete`, {
        method: 'POST',
        headers: API_HEADERS,
        body: JSON.stringify({ adminToken: token, id }),
      });
      const data = await resp.json() as { members?: MemberRow[]; error?: string };
      if (!resp.ok || data.error) throw new Error(data.error || '删除失败');
      if (openMemberId === id) setOpenMemberId(null);
      await loadMembers(token);
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败');
    } finally {
      setLoading(false);
    }
  };

  const handleAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) return;
    if (newPassword && newPassword !== confirmPassword) {
      setAccountError('两次输入的新密码不一致');
      setAccountOk('');
      return;
    }
    setSavingAccount(true);
    setAccountError('');
    setAccountOk('');
    try {
      const resp = await fetch(`${API_URL}?action=admin-account-update`, {
        method: 'POST',
        headers: API_HEADERS,
        body: JSON.stringify({
          adminToken: token,
          currentPassword,
          username: newUsername,
          password: newPassword,
        }),
      });
      const data = await resp.json() as { success?: boolean; username?: string; error?: string };
      if (!resp.ok || data.error) throw new Error(data.error || '修改失败');
      if (data.username) {
        setCurrentAdminUser(data.username);
        setNewUsername(data.username);
      }
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setAccountOk('后台账号密码已更新');
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : '修改失败');
    } finally {
      setSavingAccount(false);
    }
  };

  const handleSaveBot = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !botToken.trim()) return;
    setSavingBot(true);
    setBotError('');
    setBotOk('');
    try {
      const resp = await fetch(`${API_URL}?action=telegram-admin-save`, {
        method: 'POST',
        headers: API_HEADERS,
        body: JSON.stringify({ adminToken: token, botToken: botToken.trim(), apiBase: botApiBase.trim() }),
      });
      const data = await resp.json() as {
        error?: string;
        botUsername?: string;
        tokenMasked?: string;
      };
      if (!resp.ok || data.error) throw new Error(data.error || '保存失败');
      setBotConfigured(true);
      setBotUsername(data.botUsername || '');
      setBotMasked(data.tokenMasked || '');
      setBotToken('');
      setBotOk(data.botUsername ? `已保存，机器人 @${data.botUsername}` : '已保存');
    } catch (err) {
      setBotError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSavingBot(false);
    }
  };

  const handleClearBot = async () => {
    if (!token) return;
    if (!window.confirm('清除后会员将无法绑定 Telegram 提醒，确定清除？')) return;
    setSavingBot(true);
    setBotError('');
    setBotOk('');
    try {
      const resp = await fetch(`${API_URL}?action=telegram-admin-clear`, {
        method: 'POST',
        headers: API_HEADERS,
        body: JSON.stringify({ adminToken: token }),
      });
      const data = await resp.json() as { error?: string };
      if (!resp.ok || data.error) throw new Error(data.error || '清除失败');
      setBotConfigured(false);
      setBotUsername('');
      setBotMasked('');
      setBotToken('');
      setBotOk('已清除机器人 Token');
    } catch (err) {
      setBotError(err instanceof Error ? err.message : '清除失败');
    } finally {
      setSavingBot(false);
    }
  };

  if (!token) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-950 px-4">
        <form onSubmit={handleLogin} className="w-full max-w-sm rounded-2xl border border-slate-800 bg-slate-900 p-6 shadow-xl">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-500/15 text-amber-400">
            <Shield className="h-5 w-5" />
          </div>
          <h1 className="mt-4 text-lg font-semibold text-white">会员后台</h1>
          <p className="mt-1 text-sm text-slate-400">使用独立后台账号登录，与傲世 / 星亿账号无关。</p>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="后台账号"
            autoComplete="username"
            className="mt-5 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none focus:border-amber-400"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="后台密码"
            autoComplete="current-password"
            className="mt-3 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none focus:border-amber-400"
          />
          {error && <p className="mt-3 text-sm text-rose-400">{error}</p>}
          <button
            type="submit"
            disabled={loading || !username.trim() || !password}
            className="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-medium text-slate-950 hover:bg-amber-400 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : '进入后台'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100">
      <header className="border-b border-slate-800 bg-slate-900/80">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-500/15 text-amber-400">
              <Award className="h-5 w-5" />
            </div>
            <div>
              <h1 className="text-lg font-semibold">会员后台</h1>
              <p className="text-xs text-slate-400">当前登录：{currentAdminUser} · 可只填傲世账号；补绑星亿后才能自动投注</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => persistToken('')}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800"
          >
            <LogOut className="h-4 w-4" />
            退出
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        <form onSubmit={handleAdd} className="rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <h2 className="text-sm font-semibold text-slate-200">添加会员</h2>
          <p className="mt-1 text-xs text-slate-500">星亿账号可留空，该会员只能看数据推荐，不能自动投注。之后可在列表里补绑。</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-3">
            <input
              value={aoshiLoginId}
              onChange={(e) => setAoshiLoginId(e.target.value)}
              placeholder="傲世账号（必填）"
              className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm outline-none focus:border-amber-400"
            />
            <input
              value={xyLoginId}
              onChange={(e) => setXyLoginId(e.target.value)}
              placeholder="星亿账号（选填）"
              className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm outline-none focus:border-amber-400"
            />
            <button
              type="submit"
              disabled={loading || !aoshiLoginId.trim()}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-medium text-slate-950 hover:bg-amber-400 disabled:opacity-50"
            >
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              添加并设为会员
            </button>
          </div>
          {error && <p className="mt-3 text-sm text-rose-400">{error}</p>}
        </form>

        <div className="mt-6 overflow-hidden rounded-2xl border border-slate-800 bg-slate-900">
          <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
            <div>
              <h2 className="text-sm font-semibold text-slate-200">会员流水</h2>
              <p className="text-xs text-slate-500">北京时间 · 流水每万返 475 · 点击会员查看每天明细</p>
            </div>
            <button
              type="button"
              onClick={() => void loadMembers(token).catch((err: unknown) => {
                setError(err instanceof Error ? err.message : '刷新失败');
              })}
              className="rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
            >
              刷新
            </button>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-800/80 text-left text-slate-400">
              <tr>
                <th className="px-4 py-3 font-medium">会员</th>
                <th className="px-4 py-3 font-medium text-right">今日流水</th>
                <th className="px-4 py-3 font-medium text-right">今日盈亏</th>
                <th className="px-4 py-3 font-medium text-right">累计流水</th>
                <th className="px-4 py-3 font-medium text-right">累计盈亏</th>
                <th className="px-4 py-3 font-medium text-right">含奖励</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800">
              {members.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-4 py-10 text-center text-slate-500">还没有会员</td>
                </tr>
              )}
              {members.map((row) => {
                const days = row.days ?? [];
                const totals = row.totals ?? { turnover: 0, net: 0, rebate: 0, wins: 0, losses: 0, pending: 0, winRate: null };
                const today = days.find((item) => item.date === beijingToday());
                const open = openMemberId === row.id;
                const totalWithRebate = totals.net + totals.rebate;
                return (
                  <Fragment key={row.id}>
                    <tr className="align-top">
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          onClick={() => setOpenMemberId(open ? null : row.id)}
                          className="flex items-start gap-2 text-left"
                        >
                          {open ? <ChevronUp className="mt-0.5 h-4 w-4 text-slate-500" /> : <ChevronDown className="mt-0.5 h-4 w-4 text-slate-500" />}
                          <span>
                            <span className="block font-mono text-slate-100">{row.aoshiLoginId}</span>
                            <span className="block font-mono text-xs text-slate-500">{row.xyLoginId || '未绑定星亿'}</span>
                            <span className="mt-1 block text-xs text-slate-500">
                              {row.xyLoginId ? '可自动投注' : '仅数据推荐'} · 添加于 {formatAddedAt(row.createdAt)}
                            </span>
                          </span>
                        </button>
                      </td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-200">{money(today?.turnover ?? 0)}</td>
                      <td className={`px-4 py-3 text-right tabular-nums ${moneyClass(today?.net ?? 0)}`}>{money(today?.net ?? 0, true)}</td>
                      <td className="px-4 py-3 text-right tabular-nums text-slate-200">{money(totals.turnover)}</td>
                      <td className={`px-4 py-3 text-right tabular-nums ${moneyClass(totals.net)}`}>{money(totals.net, true)}</td>
                      <td className={`px-4 py-3 text-right tabular-nums ${moneyClass(totalWithRebate)}`}>{money(totalWithRebate, true)}</td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex justify-end gap-1">
                          <button
                            type="button"
                            onClick={() => startEdit(row)}
                            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-amber-300 hover:bg-amber-500/10"
                          >
                            <Pencil className="h-4 w-4" />
                            编辑
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleDelete(row.id)}
                            className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-rose-400 hover:bg-rose-500/10"
                          >
                            <Trash2 className="h-4 w-4" />
                            删除
                          </button>
                        </div>
                      </td>
                    </tr>
                    {editingId === row.id && (
                      <tr>
                        <td colSpan={7} className="bg-slate-950/80 px-4 py-4">
                          <form onSubmit={handleUpdate} className="grid gap-3 sm:grid-cols-3">
                            <input
                              value={editAoshi}
                              onChange={(e) => setEditAoshi(e.target.value)}
                              placeholder="傲世账号"
                              className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm outline-none focus:border-amber-400"
                            />
                            <input
                              value={editXy}
                              onChange={(e) => setEditXy(e.target.value)}
                              placeholder="星亿账号（可留空）"
                              className="rounded-xl border border-slate-700 bg-slate-900 px-3 py-2.5 text-sm outline-none focus:border-amber-400"
                            />
                            <div className="flex gap-2">
                              <button
                                type="submit"
                                disabled={loading || !editAoshi.trim()}
                                className="rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-medium text-slate-950 hover:bg-amber-400 disabled:opacity-50"
                              >
                                保存
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingId(null)}
                                className="rounded-xl border border-slate-700 px-4 py-2.5 text-sm text-slate-300 hover:bg-slate-800"
                              >
                                取消
                              </button>
                            </div>
                          </form>
                        </td>
                      </tr>
                    )}
                    {open && (
                      <tr>
                        <td colSpan={7} className="bg-slate-950/60 px-4 py-4">
                          <table className="w-full text-sm">
                            <thead className="text-left text-slate-500">
                              <tr>
                                <th className="px-3 py-2 font-medium">日期</th>
                                <th className="px-3 py-2 font-medium text-right">总投注量</th>
                                <th className="px-3 py-2 font-medium text-right">输赢</th>
                                <th className="px-3 py-2 font-medium text-right">流水奖励</th>
                                <th className="px-3 py-2 font-medium text-right">含奖励</th>
                                <th className="px-3 py-2 font-medium text-right">胜率</th>
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800">
                              {days.length === 0 && (
                                <tr>
                                  <td colSpan={6} className="px-3 py-8 text-center text-slate-500">该会员还没有投注记录</td>
                                </tr>
                              )}
                              {days.map((day) => {
                                const withRebate = day.net + day.rebate;
                                return (
                                  <tr key={day.date}>
                                    <td className="px-3 py-2 text-slate-200">{day.dateLabel}</td>
                                    <td className="px-3 py-2 text-right tabular-nums text-slate-200">{money(day.turnover)}</td>
                                    <td className={`px-3 py-2 text-right tabular-nums ${moneyClass(day.net)}`}>{money(day.net, true)}</td>
                                    <td className="px-3 py-2 text-right tabular-nums text-amber-400">+{money(day.rebate)}</td>
                                    <td className={`px-3 py-2 text-right tabular-nums ${moneyClass(withRebate)}`}>{money(withRebate, true)}</td>
                                    <td className="px-3 py-2 text-right text-slate-400">{winRateText(day)}</td>
                                  </tr>
                                );
                              })}
                            </tbody>
                          </table>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>

        <form onSubmit={handleAccount} className="mt-6 rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <div className="flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-amber-400" />
            <h2 className="text-sm font-semibold text-slate-200">修改后台账号密码</h2>
          </div>
          <p className="mt-1 text-xs text-slate-500">这里改的是后台自己的登录账号，不会动傲世或星亿账号。</p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <input
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              placeholder="新后台账号"
              autoComplete="off"
              className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm outline-none focus:border-amber-400"
            />
            <input
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="当前密码"
              autoComplete="current-password"
              className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm outline-none focus:border-amber-400"
            />
            <input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="新密码（不改可留空）"
              autoComplete="new-password"
              className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm outline-none focus:border-amber-400"
            />
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="确认新密码"
              autoComplete="new-password"
              className="rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm outline-none focus:border-amber-400"
            />
          </div>
          {accountError && <p className="mt-3 text-sm text-rose-400">{accountError}</p>}
          {accountOk && <p className="mt-3 text-sm text-emerald-400">{accountOk}</p>}
          <button
            type="submit"
            disabled={savingAccount || !currentPassword || !newUsername.trim()}
            className="mt-4 inline-flex items-center justify-center gap-2 rounded-xl border border-amber-400/40 bg-amber-500/15 px-4 py-2.5 text-sm font-medium text-amber-300 hover:bg-amber-500/25 disabled:opacity-50"
          >
            {savingAccount ? <Loader2 className="h-4 w-4 animate-spin" /> : '保存账号密码'}
          </button>
        </form>

        <form onSubmit={handleSaveBot} className="mt-6 rounded-2xl border border-slate-800 bg-slate-900 p-5">
          <div className="flex items-center gap-2">
            <Bell className="h-4 w-4 text-sky-400" />
            <h2 className="text-sm font-semibold text-slate-200">Telegram 机器人</h2>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            在 @BotFather 创建机器人后，把 Token 填在这里。本机或国内服务器经常访问不了 api.telegram.org，保存失败多半是网络而不是 Token 填错。
          </p>
          {botConfigured && (
            <p className="mt-3 text-xs text-emerald-400">
              已配置{botUsername ? ` @${botUsername}` : ''}{botMasked ? ` · ${botMasked}` : ''}
            </p>
          )}
          <div className="mt-4 flex flex-col gap-3 sm:flex-row">
            <input
              type="password"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder={botConfigured ? '输入新 Token 以更换' : '机器人 Token'}
              autoComplete="off"
              className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm outline-none focus:border-sky-400"
            />
            <button
              type="submit"
              disabled={savingBot || !botToken.trim()}
              className="rounded-xl bg-sky-500 px-4 py-2.5 text-sm font-medium text-slate-950 hover:bg-sky-400 disabled:opacity-50"
            >
              {savingBot ? '保存中…' : '保存 Token'}
            </button>
            {botConfigured && (
              <button
                type="button"
                onClick={() => void handleClearBot()}
                disabled={savingBot}
                className="rounded-xl border border-slate-700 px-4 py-2.5 text-sm text-rose-300 hover:bg-rose-500/10 disabled:opacity-50"
              >
                清除
              </button>
            )}
          </div>
          <input
            value={botApiBase}
            onChange={(e) => setBotApiBase(e.target.value)}
            placeholder="可选：Telegram API 反代，例如 https://你的域名/telegram-api"
            autoComplete="off"
            className="mt-3 w-full rounded-xl border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm outline-none focus:border-sky-400"
          />
          {botError && <p className="mt-3 text-sm text-rose-400">{botError}</p>}
          {botOk && <p className="mt-3 text-sm text-emerald-400">{botOk}</p>}
        </form>
      </main>
    </div>
  );
}
