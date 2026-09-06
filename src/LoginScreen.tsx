import { useState, useCallback, useRef, useEffect } from 'react';
import { Award, User, Lock, ShieldCheck, RefreshCw, Loader2, AlertCircle, Eye, EyeOff } from 'lucide-react';
import { API_URL } from '@/api';

interface LoginScreenProps {
  onLoginSuccess: (sessionId: string) => void;
}

export function LoginScreen({ onLoginSuccess }: LoginScreenProps) {
  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [captchaInput, setCaptchaInput] = useState('');
  const [captchaImage, setCaptchaImage] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingCaptcha, setLoadingCaptcha] = useState(false);
  const [error, setError] = useState('');
  const captchaImgRef = useRef<HTMLImageElement>(null);

  const fetchCaptcha = useCallback(async () => {
    setLoadingCaptcha(true);
    setError('');
    setCaptchaInput('');
    try {
      const resp = await fetch(`${API_URL}?action=captcha`, {
        headers: {
          'Content-Type': 'application/json',
        },
      });
      const data = (await resp.json().catch(() => ({}))) as {
        error?: string;
        captchaImage?: string;
        sessionId?: string;
      };
      if (!resp.ok || data.error || !data.captchaImage || !data.sessionId) {
        throw new Error(data.error || `获取验证码失败 (${resp.status})`);
      }
      setCaptchaImage(data.captchaImage);
      setSessionId(data.sessionId);
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取验证码失败');
    } finally {
      setLoadingCaptcha(false);
    }
  }, []);

  useEffect(() => {
    fetchCaptcha();
  }, [fetchCaptcha]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!loginId.trim() || !password.trim() || !captchaInput.trim()) {
      setError('请填写所有栏位');
      return;
    }

    setLoading(true);
    setError('');

    try {
      const resp = await fetch(`${API_URL}?action=login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sessionId,
          loginId: loginId.trim(),
          password: password.trim(),
          captchaInput: captchaInput.trim(),
        }),
      });

      const data = await resp.json();

      if (data.success) {
        onLoginSuccess(data.sessionId);
      } else {
        setError(data.error || '登录失败');
        // Refresh captcha on failure
        fetchCaptcha();
      }
    } catch {
      setError('网络错误，请重试');
      fetchCaptcha();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900 px-4 py-8">
      {/* Animated background accents */}
      <div className="pointer-events-none absolute -left-40 -top-40 h-96 w-96 rounded-full bg-sky-500/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-40 -right-40 h-96 w-96 rounded-full bg-emerald-500/10 blur-3xl" />

      <div className="relative w-full max-w-md">
        {/* Logo */}
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-sky-500 to-emerald-500 shadow-lg shadow-sky-500/20">
            <Award className="h-9 w-9 text-white" />
          </div>
          <h1 className="text-2xl font-bold text-white">腾讯10分彩</h1>
          <p className="mt-1 text-sm text-slate-400">登录后查看实时开奖数据</p>
        </div>

        {/* Login card */}
        <div className="rounded-2xl border border-white/10 bg-white/5 p-8 shadow-2xl backdrop-blur-xl">
          {error && (
            <div className="mb-5 flex items-center gap-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-3 text-sm text-rose-300">
              <AlertCircle className="h-4 w-4 flex-shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleLogin} className="space-y-5">
            {/* Account */}
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-300">
                帐号
              </label>
              <div className="relative">
                <User className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-500" />
                <input
                  type="text"
                  value={loginId}
                  onChange={(e) => setLoginId(e.target.value)}
                  placeholder="请输入帐号"
                  autoComplete="username"
                  className="w-full rounded-xl border border-white/10 bg-white/5 py-3 pl-11 pr-4 text-white placeholder-slate-500 outline-none transition focus:border-sky-400/50 focus:bg-white/10 focus:ring-2 focus:ring-sky-500/20"
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-300">
                密码
              </label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-500" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="请输入密码"
                  autoComplete="current-password"
                  className="w-full rounded-xl border border-white/10 bg-white/5 py-3 pl-11 pr-11 text-white placeholder-slate-500 outline-none transition focus:border-sky-400/50 focus:bg-white/10 focus:ring-2 focus:ring-sky-500/20"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-slate-500 transition hover:text-slate-300"
                >
                  {showPassword ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
                </button>
              </div>
            </div>

            {/* Captcha */}
            <div>
              <label className="mb-1.5 block text-sm font-medium text-slate-300">
                验证码
              </label>
              <div className="flex gap-3">
                <div className="relative flex-1">
                  <ShieldCheck className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-slate-500" />
                  <input
                    type="text"
                    value={captchaInput}
                    onChange={(e) => setCaptchaInput(e.target.value)}
                    placeholder="请输入验证码"
                    maxLength={6}
                    className="w-full rounded-xl border border-white/10 bg-white/5 py-3 pl-11 pr-4 text-white placeholder-slate-500 outline-none transition focus:border-sky-400/50 focus:bg-white/10 focus:ring-2 focus:ring-sky-500/20"
                  />
                </div>
                <button
                  type="button"
                  onClick={fetchCaptcha}
                  disabled={loadingCaptcha}
                  className="relative h-[46px] w-32 flex-shrink-0 overflow-hidden rounded-xl border border-white/10 bg-white/5 transition hover:border-sky-400/30 disabled:opacity-50"
                  title="点击刷新验证码"
                >
                  {loadingCaptcha ? (
                    <div className="flex h-full items-center justify-center">
                      <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
                    </div>
                  ) : captchaImage ? (
                    <img
                      ref={captchaImgRef}
                      src={captchaImage}
                      alt="验证码"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-slate-500">
                      <RefreshCw className="h-5 w-5" />
                    </div>
                  )}
                </button>
              </div>
            </div>

            {/* Submit */}
            <button
              type="submit"
              disabled={loading || loadingCaptcha}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-sky-500 to-emerald-500 py-3 font-semibold text-white shadow-lg shadow-sky-500/20 transition hover:shadow-xl hover:shadow-sky-500/30 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? (
                <>
                  <Loader2 className="h-5 w-5 animate-spin" />
                  登录中…
                </>
              ) : (
                '进入'
              )}
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-slate-500">
          数据来源：公开开奖记录 · 仅供数据展示参考
        </p>
      </div>
    </div>
  );
}
