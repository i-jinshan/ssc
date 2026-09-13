import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { completeTelegramBind, findMemberById, findMemberByTelegramChatId, setTelegramAlertAt } from "./members";

const ALERT_COOLDOWN_MS = 30 * 60 * 1000;
const DEFAULT_API_BASE = "https://api.telegram.org";
const tokenPath = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "telegram.json");

type TelegramFile = { botToken: string; apiBase?: string };

type TelegramState = {
  offset: number;
  timer: ReturnType<typeof setInterval> | null;
  username: string;
  usernameAt: number;
};

const g = globalThis as typeof globalThis & { __sscTelegram?: TelegramState };

let fileLoaded = false;
let storedToken = "";
let storedApiBase = "";

function state(): TelegramState {
  if (!g.__sscTelegram) {
    g.__sscTelegram = { offset: 0, timer: null, username: "", usernameAt: 0 };
  }
  return g.__sscTelegram;
}

function ensureTokenLoaded() {
  if (fileLoaded) return;
  fileLoaded = true;
  try {
    const parsed = JSON.parse(readFileSync(tokenPath, "utf8")) as Partial<TelegramFile>;
    storedToken = String(parsed.botToken ?? "").trim();
    storedApiBase = String(parsed.apiBase ?? "").trim().replace(/\/$/, "");
  } catch {
    storedToken = "";
    storedApiBase = "";
  }
}

function persistToken() {
  mkdirSync(dirname(tokenPath), { recursive: true });
  const tmp = `${tokenPath}.tmp`;
  writeFileSync(
    tmp,
    JSON.stringify({ botToken: storedToken, apiBase: storedApiBase || undefined }, null, 2),
  );
  renameSync(tmp, tokenPath);
}

export function telegramApiBase(): string {
  ensureTokenLoaded();
  const fromEnv = String(process.env.TELEGRAM_API_BASE ?? "").trim().replace(/\/$/, "");
  return fromEnv || storedApiBase || DEFAULT_API_BASE;
}

function proxyUrl(): string {
  return String(
    process.env.HTTPS_PROXY ||
      process.env.https_proxy ||
      process.env.ALL_PROXY ||
      process.env.all_proxy ||
      process.env.HTTP_PROXY ||
      process.env.http_proxy ||
      "",
  ).trim();
}

async function telegramFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const proxy = proxyUrl();
  const signal = init.signal ?? AbortSignal.timeout(12_000);
  if (proxy) {
    const { fetch: ufetch, ProxyAgent } = await import("undici");
    return ufetch(url, { ...init, signal, dispatcher: new ProxyAgent(proxy) }) as unknown as Response;
  }
  return fetch(url, { ...init, signal });
}

export function telegramBotToken(): string {
  ensureTokenLoaded();
  return storedToken;
}

export function telegramTokenMasked(): string {
  const token = telegramBotToken();
  if (!token) return "";
  if (token.length < 12) return "已配置";
  return `${token.slice(0, 8)}••••${token.slice(-4)}`;
}

export function clearTelegramBotToken() {
  ensureTokenLoaded();
  storedToken = "";
  persistToken();
  const s = state();
  s.username = "";
  s.usernameAt = 0;
  s.offset = 0;
  if (s.timer) {
    clearInterval(s.timer);
    s.timer = null;
  }
}

function apiUrl(method: string, token = telegramBotToken()): string {
  return `${telegramApiBase()}/bot${token}/${method}`;
}

async function probeBot(token: string): Promise<{ username: string } | { error: string }> {
  try {
    const resp = await telegramFetch(apiUrl("getMe", token));
    const data = (await resp.json()) as { ok?: boolean; result?: { username?: string }; description?: string };
    if (data.ok && data.result?.username) return { username: data.result.username };
    const desc = String(data.description ?? "");
    if (/unauthorized/i.test(desc)) {
      return { error: "Token 无效（Telegram 拒绝）。请到 @BotFather 用 /token 核对，或 /revoke 后换新 Token。" };
    }
    return { error: desc ? `Telegram 返回：${desc}` : "Token 校验失败" };
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    const msg = err instanceof Error ? err.message : String(err);
    if (name === "TimeoutError" || /abort|timeout|timed out|UND_ERR_CONNECT|fetch failed|ECONN|ENOTFOUND/i.test(msg)) {
      return {
        error:
          "连不上 Telegram API（超时或被墙）。Token 多半没问题。请给运行 Node 的环境配置 HTTPS_PROXY，把站点放到能访问 Telegram 的机器，或在下方填写 API 反代地址。",
      };
    }
    return { error: `无法连接 Telegram：${msg}` };
  }
}

export async function saveTelegramBotToken(raw: string, apiBaseRaw = ""): Promise<string | { username: string }> {
  const token = String(raw ?? "").trim();
  if (!token) return "请填写机器人 Token";
  if (!/^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(token)) return "Token 格式不对，应类似 123456789:AAHxxxx";
  ensureTokenLoaded();
  const prevBase = storedApiBase;
  storedApiBase = String(apiBaseRaw ?? "").trim().replace(/\/$/, "");
  const probed = await probeBot(token);
  if ("error" in probed) {
    storedApiBase = prevBase;
    return probed.error;
  }
  storedToken = token;
  persistToken();
  const s = state();
  s.username = probed.username;
  s.usernameAt = Date.now();
  s.offset = 0;
  restartTelegramPoller();
  return { username: probed.username };
}

export async function telegramBotUsername(): Promise<string> {
  const token = telegramBotToken();
  if (!token) return "";
  const s = state();
  if (s.username && Date.now() - s.usernameAt < 10 * 60_000) return s.username;
  const probed = await probeBot(token);
  if ("username" in probed) {
    s.username = probed.username;
    s.usernameAt = Date.now();
    return probed.username;
  }
  return s.username;
}

export async function sendTelegram(chatId: string, text: string): Promise<string | null> {
  if (!telegramBotToken() || !chatId) return "未配置 Telegram";
  try {
    const resp = await telegramFetch(apiUrl("sendMessage"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
    const data = (await resp.json()) as { ok?: boolean; description?: string };
    if (!data.ok) return data.description || "Telegram 发送失败";
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : "Telegram 发送失败";
  }
}

export function isLoginExpiredError(status: number, error: string): boolean {
  if (status === 401 || status === 403) return true;
  return /登录已过期|会话已过期|请重新登录|星亿娱乐登录已过期|请刷新验证码/.test(error);
}

export async function alertMemberLoginExpired(memberId: string, platform: string, error: string) {
  const member = findMemberById(memberId);
  if (!member?.telegramChatId) return;
  if (member.telegramAlertAt && Date.now() - member.telegramAlertAt < ALERT_COOLDOWN_MS) return;
  setTelegramAlertAt(memberId, Date.now());
  const platformLabel = platform === "xingyi" ? "星亿娱乐" : "傲世皇朝";
  const lines = [
    "【自动投注提醒】登录已过期",
    `傲世账号：${member.aoshiLoginId}`,
    member.xyLoginId ? `星亿账号：${member.xyLoginId}` : "",
    `平台：${platformLabel}`,
    `原因：${error || "登录失效"}`,
    "自动投注已停止，请重新登录并再次开启自动投注。",
  ].filter(Boolean);
  await sendTelegram(member.telegramChatId, lines.join("\n"));
}

async function consumeUpdates() {
  if (!telegramBotToken()) return;
  const s = state();
  try {
    const url = `${apiUrl("getUpdates")}?offset=${s.offset}&timeout=0&allowed_updates=${encodeURIComponent('["message"]')}`;
    const resp = await telegramFetch(url);
    const data = (await resp.json()) as {
      ok?: boolean;
      result?: Array<{
        update_id: number;
        message?: {
          text?: string;
          chat?: { id?: number };
          from?: { username?: string };
        };
      }>;
    };
    if (!data.ok || !Array.isArray(data.result)) return;
    for (const update of data.result) {
      s.offset = update.update_id + 1;
      const text = String(update.message?.text ?? "").trim();
      const chatId = update.message?.chat?.id;
      const fromUser = String(update.message?.from?.username ?? "").replace(/^@/, "");
      if (chatId == null) continue;
      const startToken = text.match(/^\/start(?:@\w+)?(?:\s+(\w+))?$/i)?.[1] ?? "";
      const bound = completeTelegramBind(String(chatId), startToken, fromUser);
      if (bound) {
        await sendTelegram(String(chatId), `绑定成功。以后自动投注登录过期时，会发消息到这里。\n傲世账号：${bound.aoshiLoginId}`);
      } else if (/^\/start/i.test(text) && !findMemberByTelegramChatId(String(chatId))) {
        await sendTelegram(String(chatId), "请先在自动投注页面填写你的 Telegram 用户名并点绑定，然后再打开这个机器人。");
      }
    }
  } catch {
    // ignore poll errors
  }
}

export function ensureTelegramPoller() {
  const s = state();
  if (s.timer) return;
  if (!telegramBotToken()) return;
  s.timer = setInterval(() => {
    void consumeUpdates();
  }, 2500);
  void consumeUpdates();
}

export function restartTelegramPoller() {
  const s = state();
  if (s.timer) {
    clearInterval(s.timer);
    s.timer = null;
  }
  ensureTelegramPoller();
}
