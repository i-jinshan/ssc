/** Local lottery proxy. Sessions live in memory for this Node process; no Supabase. */

import { Buffer } from "node:buffer";
import { writeFileSync } from "node:fs";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import type { Dispatcher } from "undici";
import { handleAutoBetHttp, setProxyCall, stopJobForMember } from "./auto-bet-engine";
import { clearLedger, dailySummary, loadLedger, persistLedgerNow, removeBet, summarizeDays, upsertBet } from "./bet-ledger";
import { getAdminUsername, updateAdminAccount, verifyAdminLogin } from "./admin-auth";
import { addMember, findMemberByAoshi, findMemberByXy, listMembers, removeMember, startTelegramBind, telegramPublic, unbindTelegram, updateMember, type Member } from "./members";
import { clearTelegramBotToken, ensureTelegramPoller, saveTelegramBotToken, sendTelegram, telegramApiBase, telegramBotToken, telegramBotUsername, telegramTokenMasked } from "./telegram";
import { loadPersistedSessions, savePersistedSessions } from "./runtime-store";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const LOTTERY_BASE = "https://sk.jhc3ejo8.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
/** 腾讯分分彩 / 腾讯五分彩 / 腾讯十分彩 */
const ALLOWED_LOTTERY_IDS = new Set([60, 127, 128]);
const DEFAULT_LOTTERY_ID = 128;

function resolveLotteryId(raw: unknown): number {
  const id = Number(raw);
  return ALLOWED_LOTTERY_IDS.has(id) ? id : DEFAULT_LOTTERY_ID;
}

function trendPath(lotteryId: number, issueLimit: number): string {
  return `/DrawHistory/Trend/${lotteryId}?issue=${issueLimit}&day=0`;
}

function issueKeys(issue: string): string[] {
  const raw = String(issue ?? "");
  const compact = raw.replace(/-/g, "");
  const hyphen = compact.length > 8 ? `${compact.slice(0, 8)}-${compact.slice(8)}` : raw;
  return [...new Set([raw, compact, hyphen].filter(Boolean))];
}

function issuesMatch(a: string, b: string): boolean {
  const left = new Set(issueKeys(a));
  return issueKeys(b).some((key) => left.has(key));
}

function betDedupeKey(sessionId: string, lotteryId: number, issue: string): string {
  return `${sessionId}:${lotteryId}:${String(issue).replace(/-/g, "")}`;
}

function hasPendingBet(sessionId: string, lotteryId: number, issue: string): boolean {
  const list = bets.get(sessionId) ?? [];
  return list.some(
    (bet) =>
      bet.status === "pending" &&
      bet.lottery_id === lotteryId &&
      issuesMatch(bet.issue, issue),
  );
}

const placingBetKeys = new Set<string>();

interface SessionRow {
  id: string;
  cookies: string;
  form_token: string | null;
  captcha_de_text: string | null;
  captcha_code?: string;
  login_token?: string;
  authenticated: boolean;
  login_id?: string;
}

interface BetRow {
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
  member_id?: string;
}

const sessions = new Map<string, SessionRow>();
const bets = new Map<string, BetRow[]>();

for (const bet of loadLedger()) {
  if (!bets.has(bet.session_id)) bets.set(bet.session_id, []);
  const list = bets.get(bet.session_id)!;
  if (!list.some((item) => item.id === bet.id)) list.push(bet);
}

for (const row of loadPersistedSessions()) {
  if (row?.id) sessions.set(row.id, row);
}

function persistSessions() {
  savePersistedSessions([...sessions.values()]);
}

const adminTokens = new Set<string>();

function adminAuthorized(req: Request, body: Record<string, unknown>): boolean {
  const header = req.headers.get("authorization") ?? "";
  const bearer = header.replace(/^Bearer\s+/i, "").trim();
  const token = bearer || String(body.adminToken ?? "").trim();
  return Boolean(token) && adminTokens.has(token);
}

function memberForLogin(loginId?: string | null): Member | null {
  if (!loginId) return null;
  return findMemberByAoshi(loginId) ?? findMemberByXy(loginId);
}

function memberForSession(session?: SessionRow): Member | null {
  return memberForLogin(session?.login_id);
}

function memberForSessionId(sessionId?: string): Member | null {
  if (!sessionId) return null;
  return memberForSession(sessions.get(sessionId));
}

function withMemberId<T extends { member_id?: string }>(bet: T, session?: SessionRow): T {
  const member = memberForSession(session);
  if (member) bet.member_id = member.id;
  return bet;
}

let cachedProxyUrl: string | undefined;
let cachedDispatcher: Dispatcher | undefined;

function getDispatcher(): Dispatcher | undefined {
  const url = process.env.LOTTERY_PROXY?.trim();
  if (!url) {
    cachedProxyUrl = undefined;
    cachedDispatcher = undefined;
    return undefined;
  }
  if (cachedProxyUrl !== url) {
    cachedProxyUrl = url;
    cachedDispatcher = new ProxyAgent(url);
  }
  return cachedDispatcher;
}

function lotteryFetch(url: string, init: Parameters<typeof undiciFetch>[1] = {}) {
  const dispatcher = getDispatcher();
  return undiciFetch(url, dispatcher ? { ...init, dispatcher } : init);
}

function describeFetchError(err: unknown): string {
  const cause =
    err instanceof Error && "cause" in err
      ? (err as Error & { cause?: { code?: string; message?: string } }).cause
      : undefined;
  const code = cause?.code ?? (err instanceof Error && "code" in err ? String((err as { code?: string }).code) : "");
  const proxy = process.env.LOTTERY_PROXY?.trim();
  if (code === "ECONNRESET" || /fetch failed/i.test(err instanceof Error ? err.message : String(err))) {
    if (proxy) {
      return `无法连接开奖站点。当前走代理 ${proxy}，请检查 LOTTERY_PROXY 是否可用。`;
    }
    return "无法连接开奖站点（直连失败）。本机若需代理，请设置环境变量 LOTTERY_PROXY，例如 http://127.0.0.1:10900";
  }
  return err instanceof Error ? err.message : String(err);
}

function parseSetCookie(headers: Headers): string {
  const cookies: string[] = [];
  // Deno's Headers.getAll works for set-cookie in Deno runtime
  const raw = headers.getSetCookie
    ? headers.getSetCookie()
    : null;
  if (raw && raw.length > 0) {
    for (const c of raw) {
      const cookiePart = c.split(";")[0];
      if (cookiePart) cookies.push(cookiePart);
    }
  } else {
    headers.forEach((value, key) => {
      if (key.toLowerCase() === "set-cookie") {
        const cookiePart = value.split(";")[0];
        if (cookiePart) cookies.push(cookiePart);
      }
    });
  }
  return cookies.join("; ");
}

function mergeCookies(existing: string, newCookies: string): string {
  const map = new Map<string, string>();
  const parseInto = (str: string) => {
    if (!str) return;
    str.split(";").forEach((pair) => {
      const idx = pair.indexOf("=");
      if (idx > 0) {
        const k = pair.slice(0, idx).trim();
        const v = pair.slice(idx + 1).trim();
        map.set(k, v);
      }
    });
  };
  parseInto(existing);
  parseInto(newCookies);
  return Array.from(map.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

function getFormField(html: string, name: string): string | null {
  const patterns = [
    new RegExp(`name=["']${name}["'][^>]*value=["']([^"']*)["']`, "i"),
    new RegExp(`value=["']([^"']*)["'][^>]*name=["']${name}["']`, "i"),
  ];
  for (const regex of patterns) {
    const match = html.match(regex);
    if (match) return match[1];
  }
  return null;
}

function randomHex4(): string {
  return Math.floor((1 + Math.random()) * 65536).toString(16).substring(1);
}

function generateBetGuid(): string {
  const tabId = randomHex4() + randomHex4();
  return tabId + "-" + randomHex4() + "-" + randomHex4() + "-" + randomHex4() + "-" + randomHex4() + randomHex4() + randomHex4();
}

async function fetchWithCookies(
  url: string,
  cookieStr: string,
  options: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    redirect?: "follow" | "manual";
  } = {}
): Promise<{ text: string; status: number; cookies: string; headers: Headers }> {
  const method = options.method ?? "GET";
  const reqHeaders: Record<string, string> = {
    "User-Agent": UA,
    Cookie: cookieStr,
    Referer: new URL(url).origin + "/",
    ...options.headers,
  };
  if (options.body && !reqHeaders["Content-Type"]) {
    reqHeaders["Content-Type"] = "application/x-www-form-urlencoded";
  }

  const resp = await lotteryFetch(url, {
    method,
    headers: reqHeaders,
    body: options.body,
    redirect: options.redirect ?? "manual",
  });

  const newCookies = parseSetCookie(resp.headers);
  const merged = mergeCookies(cookieStr, newCookies);
  const text = await resp.text();

  return { text, status: resp.status, cookies: merged, headers: resp.headers };
}

const ISSUE_HYPHEN = /\d{8}-\d{1,4}/;
const ISSUE_HYPHEN_START = /^\d{8}-\d{1,4}/;
const ISSUE_COMPACT = /^\d{8}\d{1,4}$/;

function parseDrawHistory(html: string): unknown[] {
  const results: unknown[] = [];
  const seen = new Set<string>();

  const addResult = (issue: string, time: string, numbers: number[]) => {
    if (numbers.length !== 5 || seen.has(issue)) return;
    if (numbers.some((number) => number < 0 || number > 9)) return;
    seen.add(issue);
    results.push({ issue, time, numbers });
  };

  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRegex.exec(html)) !== null) {
    const rowContent = rowMatch[1];
    const plainRow = rowContent
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    const issueMatch = plainRow.match(ISSUE_HYPHEN);
    if (!issueMatch) continue;

    const timeMatch = plainRow.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?/);
    const afterIssue = plainRow.slice((issueMatch.index ?? 0) + issueMatch[0].length);
    const numberTokens = afterIssue.match(/(?<!\d)\d(?!\d)/g) ?? [];
    addResult(
      issueMatch[0],
      timeMatch?.[0] ?? "",
      numberTokens.slice(0, 5).map((value) => Number(value))
    );
  }

  // Some versions render the results outside table cells. Match an issue number
  // and the next five single-digit values from the surrounding markup.
  const issueRegex = /\d{8}-\d{1,4}/g;
  let issueMatch: RegExpExecArray | null;
  while ((issueMatch = issueRegex.exec(html)) !== null) {
    const fragment = html.slice(issueMatch.index, issueMatch.index + 1800)
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;|&#160;/gi, " ")
      .replace(/\s+/g, " ");
    const timeMatch = fragment.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?/);
    const afterIssue = fragment.slice(issueMatch[0].length);
    let numberTokens: string[] = afterIssue.match(/(?<!\d)\d(?!\d)/g) ?? [];
    if (numberTokens.length < 5) {
      const numberClasses = fragment.match(
        /(?:num|number|ball|lottery)[-_]?(?:n|num)?([0-9])/gi
      ) ?? [];
      numberTokens = numberClasses
        .map((value) => value.match(/([0-9])$/)?.[1] ?? "")
        .filter((value) => value !== "");
    }
    if (numberTokens.length < 5) {
      numberTokens =
        fragment
          .match(/data-(?:number|value)=["']([0-9])["']/gi)
          ?.map((value) => value.match(/([0-9])["']$/)?.[1] ?? "")
          .filter((value) => value !== "") ?? numberTokens;
    }
    addResult(
      issueMatch[0],
      timeMatch?.[0] ?? "",
      numberTokens.slice(0, 5).map((value) => Number(value))
    );
  }

  return results;
}

function parseEmbeddedData(html: string): unknown[] {
  const results: unknown[] = [];

  const dataBlockRegex =
    /(?:var\s+\w+\s*=\s*|data\s*[:=]\s*)(\[[\s\S]*?\]);/g;
  let match: RegExpExecArray | null;
  while ((match = dataBlockRegex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (Array.isArray(parsed) && parsed.length > 0) {
        for (const item of parsed) {
          if (Array.isArray(item) && item.length >= 7) {
            const issue = String(item[0]);
            const time = String(item[1]);
            const numbers = item.slice(2, 7).map((n: unknown) =>
              typeof n === "number" ? n : parseInt(String(n), 10)
            );
            if (ISSUE_HYPHEN_START.test(issue) && numbers.every((n) => n >= 0 && n <= 9)) {
              results.push({ issue, time, numbers });
            }
          }
        }
      }
    } catch {
      // not valid JSON, skip
    }
  }

  return results;
}

function parseRawData(html: string): unknown[] {
  const results: unknown[] = [];
  const match = html.match(/_rawData\s*=\s*"([^"]+)"/);
  if (!match) return results;

  const issues = match[1].split("|");
  for (const issueStr of issues) {
    const parts = issueStr.split(",");
    if (parts.length < 6) continue;
    const issue = parts[0];
    if (!ISSUE_COMPACT.test(issue) && !ISSUE_HYPHEN_START.test(issue)) continue;
    const numbers = parts.slice(1, 6).map((n) => parseInt(n, 10));
    if (numbers.some((n) => isNaN(n) || n < 0 || n > 9)) continue;
    const timeMatch = issueStr.match(/\d{2}:\d{2}/);
    results.push({ issue, time: timeMatch ? timeMatch[0] : "", numbers });
  }

  return results;
}

export async function handleLotteryProxy(req: Request): Promise<Response> {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const action = url.searchParams.get("action") ?? "captcha";

    const autoBetResp = await handleAutoBetHttp(action, req);
    if (autoBetResp) return autoBetResp;

    if (action === "admin-login") {
      const body = (await req.json().catch(() => ({}))) as { username?: string; password?: string };
      if (!verifyAdminLogin(String(body.username ?? ""), String(body.password ?? ""))) {
        return new Response(JSON.stringify({ error: "账号或密码错误" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const token = crypto.randomUUID();
      adminTokens.add(token);
      return new Response(JSON.stringify({
        success: true,
        adminToken: token,
        username: getAdminUsername(),
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "admin-account") {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      if (!adminAuthorized(req, body)) {
        return new Response(JSON.stringify({ error: "请先登录后台" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ username: getAdminUsername() }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "admin-account-update") {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      if (!adminAuthorized(req, body)) {
        return new Response(JSON.stringify({ error: "请先登录后台" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const result = updateAdminAccount(
        String(body.currentPassword ?? ""),
        String(body.username ?? ""),
        String(body.password ?? ""),
      );
      if (typeof result === "string") {
        return new Response(JSON.stringify({ error: result }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ success: true, username: result.username }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "telegram-admin-status") {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      if (!adminAuthorized(req, body)) {
        return new Response(JSON.stringify({ error: "请先登录后台" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const username = await telegramBotUsername();
      return new Response(JSON.stringify({
        configured: Boolean(telegramBotToken()),
        tokenMasked: telegramTokenMasked(),
        botUsername: username,
        apiBase: telegramApiBase() === "https://api.telegram.org" ? "" : telegramApiBase(),
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "telegram-admin-save") {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      if (!adminAuthorized(req, body)) {
        return new Response(JSON.stringify({ error: "请先登录后台" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const result = await saveTelegramBotToken(String(body.botToken ?? ""), String(body.apiBase ?? ""));
      if (typeof result === "string") {
        return new Response(JSON.stringify({ error: result }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        success: true,
        configured: true,
        botUsername: result.username,
        tokenMasked: telegramTokenMasked(),
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "telegram-admin-clear") {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      if (!adminAuthorized(req, body)) {
        return new Response(JSON.stringify({ error: "请先登录后台" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      clearTelegramBotToken();
      return new Response(JSON.stringify({ success: true, configured: false }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "members-list") {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      if (!adminAuthorized(req, body)) {
        return new Response(JSON.stringify({ error: "请先登录后台" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const members = listMembers().map((member) => {
        const days = dailySummary(member.id);
        return {
          ...member,
          days,
          totals: summarizeDays(days),
        };
      });
      return new Response(JSON.stringify({
        members,
        username: getAdminUsername(),
        rebatePerTurnover: 10000,
        rebateAmount: 475,
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "members-add") {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      if (!adminAuthorized(req, body)) {
        return new Response(JSON.stringify({ error: "请先登录后台" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const result = addMember(String(body.aoshiLoginId ?? ""), String(body.xyLoginId ?? ""));
      if (typeof result === "string") {
        return new Response(JSON.stringify({ error: result }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ success: true, member: result, members: listMembers() }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "members-update") {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      if (!adminAuthorized(req, body)) {
        return new Response(JSON.stringify({ error: "请先登录后台" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const id = String(body.id ?? "");
      const before = id ? listMembers().find((item) => item.id === id) : null;
      const result = updateMember(id, String(body.aoshiLoginId ?? ""), String(body.xyLoginId ?? ""));
      if (typeof result === "string") {
        return new Response(JSON.stringify({ error: result }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (before?.xyLoginId && !result.xyLoginId) stopJobForMember(id);
      return new Response(JSON.stringify({ success: true, member: result, members: listMembers() }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "members-delete") {
      const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
      if (!adminAuthorized(req, body)) {
        return new Response(JSON.stringify({ error: "请先登录后台" }), {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const id = String(body.id ?? "");
      if (!id || !removeMember(id)) {
        return new Response(JSON.stringify({ error: "会员不存在" }), {
          status: 404,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      stopJobForMember(id);
      return new Response(JSON.stringify({ success: true, members: listMembers() }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "member-check") {
      const body = (await req.json().catch(() => ({}))) as { sessionId?: string; loginId?: string };
      const member = body.sessionId
        ? memberForSessionId(body.sessionId)
        : memberForLogin(body.loginId);
      return new Response(
        JSON.stringify({
          isMember: Boolean(member),
          canAutoBet: Boolean(member?.xyLoginId),
          member: member
            ? {
                id: member.id,
                aoshiLoginId: member.aoshiLoginId,
                xyLoginId: member.xyLoginId,
                createdAt: member.createdAt,
              }
            : null,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (action === "telegram-status") {
      const body = (await req.json().catch(() => ({}))) as { sessionId?: string };
      const member = memberForSessionId(body.sessionId);
      if (!member) {
        return new Response(JSON.stringify({ error: "不是会员" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const username = await telegramBotUsername();
      return new Response(
        JSON.stringify({
          configured: Boolean(telegramBotToken()),
          botUsername: username,
          ...telegramPublic(member),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (action === "telegram-bind-start") {
      const body = (await req.json().catch(() => ({}))) as { sessionId?: string; username?: string };
      const member = memberForSessionId(body.sessionId);
      if (!member) {
        return new Response(JSON.stringify({ error: "不是会员" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (!telegramBotToken()) {
        return new Response(JSON.stringify({ error: "请先在会员后台配置 Telegram 机器人 Token" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const result = startTelegramBind(member.id, String(body.username ?? ""));
      if (typeof result === "string") {
        return new Response(JSON.stringify({ error: result }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const botName = await telegramBotUsername();
      const botLink = botName ? `https://t.me/${botName}?start=${result.bindToken}` : "";
      return new Response(
        JSON.stringify({
          success: true,
          configured: true,
          botUsername: botName,
          username: result.username,
          pending: true,
          expiresAt: result.expiresAt,
          botLink,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (action === "telegram-unbind") {
      const body = (await req.json().catch(() => ({}))) as { sessionId?: string };
      const member = memberForSessionId(body.sessionId);
      if (!member) {
        return new Response(JSON.stringify({ error: "不是会员" }), {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      unbindTelegram(member.id);
      return new Response(JSON.stringify({ success: true, bound: false }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "telegram-test") {
      const body = (await req.json().catch(() => ({}))) as { sessionId?: string };
      const member = memberForSessionId(body.sessionId);
      if (!member?.telegramChatId) {
        return new Response(JSON.stringify({ error: "请先绑定 Telegram" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const err = await sendTelegram(member.telegramChatId, `【测试】自动投注提醒已接通。\n傲世账号：${member.aoshiLoginId}`);
      if (err) {
        return new Response(JSON.stringify({ error: err }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (action === "captcha") {
      // Step 1: Fetch homepage to get antiforgery cookie + token
      const home = await fetchWithCookies(LOTTERY_BASE + "/", "", {
        redirect: "follow",
      });

      const formToken = getFormField(home.text, "__RequestVerificationToken");

      // Step 2: Fetch captcha fragment — requires homepage cookies + Referer
      const captchaFrag = await fetchWithCookies(
        LOTTERY_BASE + "/Account/Captcha",
        home.cookies,
        {
          method: "POST",
          body: "CaptchaError=False",
          headers: {
            "X-Requested-With": "XMLHttpRequest",
            "Content-Type": "application/x-www-form-urlencoded",
            Referer: LOTTERY_BASE + "/",
          },
        }
      );

      const captchaDeText = getFormField(captchaFrag.text, "CaptchaDeText");

      if (!captchaDeText) {
        return new Response(
          JSON.stringify({
            error: "无法获取验证码令牌",
            debug: captchaFrag.text.slice(0, 500),
          }),
          {
            status: 502,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      // Step 3: Fetch captcha image — requires session cookies + Referer
      const captchaImgResp = await lotteryFetch(
        LOTTERY_BASE + "/DefaultCaptcha/Generate?t=" + captchaDeText,
        {
          headers: {
            "User-Agent": UA,
            Cookie: captchaFrag.cookies,
            Referer: LOTTERY_BASE + "/",
          },
        }
      );

      if (!captchaImgResp.ok) {
        return new Response(
          JSON.stringify({
            error: `获取验证码图片失败 (${captchaImgResp.status})`,
          }),
          {
            status: 502,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      const imgBuffer = await captchaImgResp.arrayBuffer();
      const imgBytes = new Uint8Array(imgBuffer);
      let imgBase64: string;
      if (typeof Buffer !== "undefined") {
        imgBase64 = Buffer.from(imgBuffer).toString("base64");
      } else {
        let binary = "";
        const chunk = 0x8000;
        for (let i = 0; i < imgBytes.length; i += chunk) {
          binary += String.fromCharCode(...imgBytes.subarray(i, i + chunk));
        }
        imgBase64 = btoa(binary);
      }
      const contentType = captchaImgResp.headers.get("content-type")?.split(";")[0].trim() || "image/gif";
      console.error(`[captcha] imgBytes=${imgBytes.length} base64Len=${imgBase64.length} type=${contentType}`);

      const sessionId = crypto.randomUUID();
      sessions.set(sessionId, {
        id: sessionId,
        cookies: captchaFrag.cookies,
        form_token: formToken,
        captcha_de_text: captchaDeText,
        authenticated: false,
      });

      return new Response(
        JSON.stringify({
          sessionId,
          captchaImage: `data:${contentType};base64,${imgBase64}`,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "login") {
      const body = await req.json();
      const { sessionId, loginId, password, captchaInput } = body as {
        sessionId: string;
        loginId: string;
        password: string;
        captchaInput: string;
      };

      const session = sessions.get(sessionId);

      if (!session) {
        return new Response(
          JSON.stringify({ error: "会话已过期，请刷新验证码" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      const row = session;
      const cookies = row.cookies;
      const formToken = row.form_token;
      const captchaDeText = row.captcha_de_text;

      const loginBody = new URLSearchParams({
        __RequestVerificationToken: formToken ?? "",
        LoginID: loginId,
        Password: password,
        CaptchaDeText: captchaDeText ?? "",
        CaptchaInputText: captchaInput,
      }).toString();

      const loginResp = await fetchWithCookies(
        LOTTERY_BASE + "/Account/LoginVerify",
        cookies,
        {
          method: "POST",
          body: loginBody,
          headers: {
            "X-Requested-With": "XMLHttpRequest",
            "Content-Type": "application/x-www-form-urlencoded",
            Referer: LOTTERY_BASE + "/",
          },
        }
      );

      const isRedirect = loginResp.status >= 300 && loginResp.status < 400;
      const hasError =
        /field-validation-error|验证码错误|帐号或密码|账号或密码|登录失败|登入失败|密码错误/i.test(
          loginResp.text
        );

      let finalCookies = loginResp.cookies;
      if (isRedirect && !hasError) {
        let currentResp = loginResp;
        for (let i = 0; i < 8; i++) {
          if (currentResp.status < 300 || currentResp.status >= 400) break;
          const location = currentResp.headers.get("location");
          if (!location) break;
          const redirectUrl = location.startsWith("http")
            ? location
            : LOTTERY_BASE + (location.startsWith("/") ? location : "/" + location);
          currentResp = await fetchWithCookies(
            redirectUrl,
            currentResp.cookies,
            { redirect: "manual" }
          );
          finalCookies = currentResp.cookies;
        }
        // Verify the session is actually authenticated by hitting a protected page
        const verifyResp = await fetchWithCookies(
          LOTTERY_BASE + trendPath(DEFAULT_LOTTERY_ID, 5),
          finalCookies,
          { redirect: "manual" }
        );
        finalCookies = verifyResp.cookies;
        const stillTimeout = /ErrorHandle\/Timeout|top\.location\.href/.test(
          verifyResp.text
        );
        if (stillTimeout) {
          return new Response(
            JSON.stringify({ success: false, error: "登录后仍无法访问开奖页面，请重试" }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      }

      if (isRedirect && !hasError) {
        sessions.set(sessionId, {
          ...session,
          cookies: finalCookies,
          authenticated: true,
          login_id: loginId,
        });
        persistSessions();
        const member = findMemberByAoshi(loginId);

        return new Response(
          JSON.stringify({
            success: true,
            sessionId,
            loginId,
            isMember: Boolean(member),
            member: member
              ? { id: member.id, aoshiLoginId: member.aoshiLoginId, xyLoginId: member.xyLoginId }
              : null,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } else {
        let errorMsg = "登录失败，请检查账号密码和验证码";

        if (/验证码/i.test(loginResp.text)) {
          errorMsg = "验证码错误";
        } else if (/帐号或密码|账号或密码|密码错误/i.test(loginResp.text)) {
          errorMsg = "账号或密码错误";
        }

        return new Response(
          JSON.stringify({ success: false, error: errorMsg }),
          {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }
    }

    if (action === "draws") {
      const body = await req.json();
      const { sessionId, issueCount, lotteryId: lotteryIdRaw } = body as {
        sessionId: string;
        issueCount?: number;
        lotteryId?: number;
      };
      const issueLimit = Math.min(100, Math.max(1, Number(issueCount) || 100));
      const lotteryId = resolveLotteryId(lotteryIdRaw);

      const session = sessions.get(sessionId);

      if (!session) {
        return new Response(
          JSON.stringify({ error: "会话已过期，请重新登录" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      const cookies = session.cookies;

      const trendUrl = LOTTERY_BASE + trendPath(lotteryId, issueLimit);

      // Follow redirects manually to collect all cookies across the chain
      let trendResp = await fetchWithCookies(trendUrl, cookies, {
        redirect: "manual",
      });
      let currentCookies = trendResp.cookies;
      for (let i = 0; i < 8; i++) {
        if (trendResp.status < 300 || trendResp.status >= 400) break;
        const location = trendResp.headers.get("location");
        if (!location) break;
        const redirectUrl = location.startsWith("http")
          ? location
          : LOTTERY_BASE + (location.startsWith("/") ? location : "/" + location);
        trendResp = await fetchWithCookies(redirectUrl, currentCookies, {
          redirect: "manual",
        });
        currentCookies = trendResp.cookies;
      }

      const loginPage =
        /ErrorHandle\/Timeout|top\.location\.href|<form[^>]+action=["']\/Account\/LoginVerify|id=["']form["'][^>]*method=["']post/i.test(
          trendResp.text
        );
      if (loginPage) {
        return new Response(
          JSON.stringify({ error: "登录已过期，请重新登录" }),
          {
            status: 401,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      let draws = parseRawData(trendResp.text);
      if (draws.length === 0) {
        draws = parseEmbeddedData(trendResp.text);
      }
      if (draws.length === 0) {
        draws = parseDrawHistory(trendResp.text);
      }

      sessions.set(sessionId, { ...session, cookies: currentCookies });
      persistSessions();

      return new Response(
        JSON.stringify({
          draws,
          rawLength: trendResp.text.length,
          status: trendResp.status,
          error: draws.length === 0 ? "上游页面暂未返回可识别的开奖数据" : undefined,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "betpage") {
      const body = await req.json();
      const { sessionId, lotteryId: lotteryIdRaw } = body as {
        sessionId: string;
        lotteryId?: number;
      };
      const lotteryId = resolveLotteryId(lotteryIdRaw);

      const session = sessions.get(sessionId);
      if (!session) {
        return new Response(
          JSON.stringify({ error: "no session" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const cookies = session.cookies;
      const pageUrl = LOTTERY_BASE + "/Home/Home";
      const pageResp = await fetchWithCookies(pageUrl, cookies, {
        redirect: "manual",
      });
      let currentCookies = pageResp.cookies;
      for (let i = 0; i < 8; i++) {
        if (pageResp.status < 300 || pageResp.status >= 400) break;
        const location = pageResp.headers.get("location");
        if (!location) break;
        const redirectUrl = location.startsWith("http")
          ? location
          : LOTTERY_BASE + (location.startsWith("/") ? location : "/" + location);
        const next = await fetchWithCookies(redirectUrl, currentCookies, { redirect: "manual" });
        currentCookies = next.cookies;
        break;
      }

      sessions.set(sessionId, { ...session, cookies: currentCookies });

      return new Response(
        JSON.stringify({
          status: pageResp.status,
          length: pageResp.text.length,
          isLoginPage: /ErrorHandle\/Timeout|top\.location\.href|<form[^>]+action=["']\/Account\/LoginVerify/i.test(pageResp.text),
          html: pageResp.text,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "debug") {
      const body = await req.json();
      const { sessionId, lotteryId: lotteryIdRaw } = body as {
        sessionId: string;
        lotteryId?: number;
      };
      const lotteryId = resolveLotteryId(lotteryIdRaw);

      const session = sessions.get(sessionId);

      if (!session) {
        return new Response(
          JSON.stringify({ error: "no session" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      const cookies = session.cookies;
      const trendUrl = LOTTERY_BASE + trendPath(lotteryId, 100);
      const trendResp = await fetchWithCookies(trendUrl, cookies, {
        redirect: "follow",
      });

      const rawDraws = parseRawData(trendResp.text);
      const embeddedDraws = parseEmbeddedData(trendResp.text);
      const tableDraws = parseDrawHistory(trendResp.text);

      return new Response(
        JSON.stringify({
          status: trendResp.status,
          length: trendResp.text.length,
          isLoginPage: /ErrorHandle\/Timeout|top\.location\.href|<form[^>]+action=["']\/Account\/LoginVerify/i.test(trendResp.text),
          embeddedDrawsCount: embeddedDraws.length,
          tableDrawsCount: tableDraws.length,
          draws: rawDraws.length > 0 ? rawDraws : (embeddedDraws.length > 0 ? embeddedDraws : tableDraws),
          html: trendResp.text.slice(0, 8000),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "bet") {
      const body = await req.json();
      const { sessionId, lotteryId, issue, picks, betAmount, position } = body as {
        sessionId: string;
        lotteryId: number;
        issue: string;
        picks: number[];
        betAmount: number;
        position?: number;
      };
      const betPosition = position >= 1 && position <= 5 ? Math.round(position) : 5;
      const numberParts = ["", "", "", "", ""];
      numberParts[betPosition - 1] = "{pos}";

      if (!sessionId || !lotteryId || !issue || !Array.isArray(picks) || picks.length === 0 || !betAmount) {
        return new Response(
          JSON.stringify({ error: "参数不完整" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const session = sessions.get(sessionId);
      if (!session) {
        return new Response(
          JSON.stringify({ error: "会话已过期，请重新登录" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (!memberForSession(session)) {
        return new Response(
          JSON.stringify({ error: "当前账号不是会员，无法投注" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const cookies = session.cookies;

      const aoshiDedupeKey = betDedupeKey(sessionId, lotteryId, issue);
      if (placingBetKeys.has(aoshiDedupeKey) || hasPendingBet(sessionId, lotteryId, issue)) {
        return new Response(
          JSON.stringify({ success: true, duplicate: true, issue }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      placingBetKeys.add(aoshiDedupeKey);
      try {
      // Step 1: Load the bet page first to establish session state and get anti-forgery token
      const betPageUrl = LOTTERY_BASE + "/Bet/Index?gid=" + lotteryId;
      let betPageResp = await fetchWithCookies(betPageUrl, cookies, { redirect: "manual" });
      let betPageCookies = betPageResp.cookies;
      let betPageHtml = betPageResp.text;
      for (let i = 0; i < 8; i++) {
        if (betPageResp.status < 300 || betPageResp.status >= 400) break;
        const location = betPageResp.headers.get("location");
        if (!location) break;
        const redirectUrl = location.startsWith("http")
          ? location
          : LOTTERY_BASE + (location.startsWith("/") ? location : "/" + location);
        const next = await fetchWithCookies(redirectUrl, betPageCookies, { redirect: "manual" });
        betPageCookies = next.cookies;
        betPageHtml = next.text;
        betPageResp = next;
        break;
      }

      const isBetPageLogin = /ErrorHandle\/Timeout|top\.location\.href/i.test(betPageHtml);
      if (isBetPageLogin) {
        return new Response(
          JSON.stringify({ error: "登录已过期，请重新登录" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Extract anti-forgery token from the bet page
      const betFormToken = getFormField(betPageHtml, "__RequestVerificationToken");

      // lotteryId (60/127/128) IS the LottoGame enum value — use it directly
      const realGameId = lotteryId;

      // Step 2: POST /Bet/GameInfo — tells the server which game is active
      const gameInfoResp = await fetchWithCookies(
        LOTTERY_BASE + "/Bet/GameInfo",
        betPageCookies,
        {
          method: "POST",
          body: "lotteryGameId=" + realGameId,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "X-Requested-With": "XMLHttpRequest",
            Referer: betPageUrl,
          },
        }
      );
      betPageCookies = gameInfoResp.cookies;

      // Step 3: POST /Bet/GetBetParameters — loads bet parameters for the game
      const betParamsResp = await fetchWithCookies(
        LOTTERY_BASE + "/Bet/GetBetParameters",
        betPageCookies,
        {
          method: "POST",
          body: "gameURLID=" + lotteryId,
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "X-Requested-With": "XMLHttpRequest",
            Referer: betPageUrl,
          },
        }
      );
      betPageCookies = betParamsResp.cookies;

      const debugInfo: Record<string, unknown> = {
        realGameId,
        lotteryId,
        betPageStatus: betPageResp.status,
        gameInfoStatus: gameInfoResp.status,
        gameInfoBody: gameInfoResp.text.slice(0, 500),
        betParamsStatus: betParamsResp.status,
        betParamsBody: betParamsResp.text.slice(0, 500),
        betFormToken: betFormToken ? "found" : "missing",
      };

      // Persist updated cookies back to the session
      sessions.set(sessionId, { ...session, cookies: betPageCookies });

      const serialNumber = issue.replace(/-/g, "");
      const guid = generateBetGuid();
      const unit = 2;
      const multiple = Math.max(1, Math.round(betAmount / unit));
      const betId = crypto.randomUUID();

      const betData = {
        LotteryGameID: realGameId,
        SerialNumber: serialNumber,
        Bets: picks.map((n) => ({
          BetTypeCode: 21,
          BetTypeName: "",
          Number: numberParts.join(",").replace("{pos}", String(n)),
          Position: String(betPosition),
          Unit: unit,
          Multiple: multiple,
          ReturnRate: 0,
          IsCompressed: false,
          NoCommission: false,
        })),
        Schedules: [],
        StopIfWin: false,
        BetMode: 0,
        Guid: guid,
        IsLoginByWeChat: false,
      };

      const betResp = await fetchWithCookies(
        LOTTERY_BASE + "/Bet/Confirm?tgid=" + guid,
        betPageCookies,
        {
          method: "POST",
          body: JSON.stringify(betData),
          headers: {
            "Content-Type": "application/json; charset=utf-8",
            "X-Requested-With": "XMLHttpRequest",
            Referer: betPageUrl,
            ...(betFormToken ? { "__RequestVerificationToken": betFormToken } : {}),
          },
        }
      );

      let betResult: unknown;
      try {
        betResult = JSON.parse(betResp.text);
      } catch {
        betResult = { raw: betResp.text.slice(0, 500) };
      }

      const isLoginRedirect = /ErrorHandle\/Timeout|top\.location\.href/i.test(betResp.text);
      if (isLoginRedirect) {
        return new Response(
          JSON.stringify({ error: "登录已过期，请重新登录" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const hasError = typeof betResult === "object" && betResult !== null && "ErrorMessage" in betResult && (betResult as { ErrorMessage: string }).ErrorMessage;
      if (hasError) {
        return new Response(
          JSON.stringify({
            error: (betResult as { ErrorMessage: string }).ErrorMessage,
            debug: { ...debugInfo, betResult },
          }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const totalCost = betAmount * picks.length;
      const bet: BetRow = withMemberId({
        id: betId,
        session_id: sessionId,
        lottery_id: lotteryId,
        issue,
        picks,
        bet_amount: betAmount,
        total_cost: totalCost,
        status: "pending",
        result_number: null,
        payout: 0,
        net: 0,
        position: betPosition,
        created_at: new Date().toISOString(),
        settled_at: null,
      }, session);

      if (!bets.has(sessionId)) bets.set(sessionId, []);
      bets.get(sessionId)!.push(bet);
      upsertBet(bet);

      return new Response(
        JSON.stringify({ success: true, betId, betResult, issue }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
      } finally {
        placingBetKeys.delete(aoshiDedupeKey);
      }
    }

    if (action === "betlist") {
      const body = await req.json();
      const { lotteryId, status, sessionId } = body as {
        sessionId?: string;
        lotteryId?: number;
        status?: string;
      };

      const member = memberForSessionId(sessionId);
      let list = member ? loadLedger(member.id) : [];
      if (lotteryId) list = list.filter((b) => b.lottery_id === lotteryId);
      if (status) list = list.filter((b) => b.status === status);
      list = [...list].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "")).slice(0, 2000);

      return new Response(
        JSON.stringify({ bets: list }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "betsettle") {
      const body = await req.json();
      const { sessionId, draws } = body as {
        sessionId: string;
        draws: { issue: string; numbers: number[] }[];
      };

      if (!sessionId || !Array.isArray(draws)) {
        return new Response(
          JSON.stringify({ error: "参数不完整" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const ODDS = 9.49;
      let settledCount = 0;
      const sessionBets = [...bets.values()].flat();

      for (const draw of draws) {
        if (!Array.isArray(draw.numbers) || draw.numbers.length < 1) continue;

        for (const bet of sessionBets) {
          if (bet.status !== "pending") continue;
          if (!issuesMatch(bet.issue, draw.issue)) continue;

          const resultNumber = draw.numbers[(bet.position ?? 5) - 1];
          if (typeof resultNumber !== "number" || !Number.isFinite(resultNumber)) continue;
          const hit = bet.picks.includes(resultNumber);
          const payout = hit ? bet.bet_amount * ODDS : 0;
          const net = payout - bet.total_cost;
          bet.status = hit ? "won" : "lost";
          bet.result_number = resultNumber;
          bet.payout = payout;
          bet.net = net;
          bet.settled_at = new Date().toISOString();
          settledCount++;
          upsertBet(bet);
        }
      }
      if (settledCount > 0) persistLedgerNow();

      return new Response(
        JSON.stringify({ success: true, settledCount }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "betdelete") {
      const body = await req.json();
      const { betId, sessionId } = body as { betId: string; sessionId?: string };

      if (!betId) {
        return new Response(
          JSON.stringify({ error: "缺少投注ID" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      let foundSid: string | null = sessionId && bets.has(sessionId) ? sessionId : null;
      let foundIdx = -1;
      if (foundSid) {
        foundIdx = (bets.get(foundSid) ?? []).findIndex((b) => b.id === betId);
        if (foundIdx < 0) foundSid = null;
      }
      if (!foundSid) {
        for (const [sid, list] of bets.entries()) {
          const idx = list.findIndex((b) => b.id === betId);
          if (idx >= 0) {
            foundSid = sid;
            foundIdx = idx;
            break;
          }
        }
      }
      if (!foundSid || foundIdx < 0) {
        return new Response(
          JSON.stringify({ error: "找不到该投注记录" }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const list = bets.get(foundSid) ?? [];
      const target = list[foundIdx];
      const session = sessions.get(foundSid);
      const xyToken = session?.login_token ?? "";

      if (xyToken && target.status === "pending") {
        const xyBase = "https://s.xybet00.com";
        const referer = `${xyBase}/Bet/${target.lottery_id}`;
        const xyPost = async (path: string, payload?: unknown) => {
          const resp = await lotteryFetch(xyBase + path, {
            method: "POST",
            headers: {
              "User-Agent": UA,
              Accept: "application/json, text/javascript, */*; q=0.01",
              "X-Requested-With": "XMLHttpRequest",
              Origin: xyBase,
              Referer: referer,
              Authorization: "Bearer " + xyToken,
              "Content-Type": "application/json; charset=utf-8",
              ...(session?.cookies ? { Cookie: session.cookies } : {}),
            },
            body: JSON.stringify(payload ?? {}),
            redirect: "manual",
            signal: AbortSignal.timeout(20000),
          });
          const cookies = mergeCookies(session?.cookies ?? "", parseSetCookie(resp.headers));
          if (session) sessions.set(foundSid!, { ...session, cookies });
          const text = await resp.text();
          let data: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(text) as unknown;
            data = parsed && typeof parsed === "object" && !Array.isArray(parsed)
              ? parsed as Record<string, unknown>
              : { Data: parsed };
          } catch {
            data = { rawText: text.slice(0, 800) };
          }
          return { status: resp.status, data };
        };

        const collectIds = (value: unknown): string[] => {
          const ids: string[] = [];
          const push = (item: unknown) => {
            if (typeof item === "string" && item) ids.push(item);
            else if (typeof item === "number" && Number.isFinite(item)) ids.push(String(item));
            else if (item && typeof item === "object" && !Array.isArray(item)) {
              const rec = item as Record<string, unknown>;
              for (const key of ["ID", "Id", "id", "BetID"]) push(rec[key]);
            }
          };
          if (Array.isArray(value)) value.forEach(push);
          else push(value);
          return [...new Set(ids)];
        };

        let remoteIds = [...(target.remote_ids ?? [])];
        if (remoteIds.length === 0) {
          try {
            const search = await xyPost("/api/BetRecord/Search", {
              StartDaysFromNow: -1,
              EndDaysFromNow: 0,
            });
            const payload = search.data.Data ?? search.data.data ?? search.data;
            const records = Array.isArray(payload)
              ? payload
              : Array.isArray((payload as { data?: unknown })?.data)
                ? (payload as { data: unknown[] }).data
                : [];
            const compactIssue = String(target.issue).replace(/-/g, "");
            remoteIds = records.flatMap((row) => {
              if (!row || typeof row !== "object") return [];
              const rec = row as Record<string, unknown>;
              const gameId = Number(rec.LotteryGameId ?? rec.LotteryGameID ?? rec.lotteryGameId);
              const serial = String(rec.SerialNumber ?? rec.IssueSerialNumber ?? rec.serialNumber ?? "").replace(/-/g, "");
              const state = rec.State ?? rec.state;
              const isOpen = state === 0 || state === "BET" || state === "Bet";
              if (gameId === target.lottery_id && serial === compactIssue && isOpen) {
                return collectIds(rec);
              }
              return [];
            });
          } catch {
            // ignore lookup failure; cancel will fail below if still empty
          }
        }

        if (remoteIds.length === 0) {
          return new Response(
            JSON.stringify({ error: "找不到星亿娱乐对应注单，无法同步撤单" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        for (const remoteId of remoteIds) {
          const cancelResp = await xyPost(`/api/Bet/Cancel/${remoteId}`);
          if (cancelResp.status === 401 || cancelResp.status === 403) {
            return new Response(
              JSON.stringify({ error: "星亿娱乐登录已过期，请重新登录后再撤单" }),
              { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }
          const code = cancelResp.data.Code ?? cancelResp.data.code;
          const alreadyGone = code === 1 && /已撤|已经撤|不存在|关盘/.test(String(cancelResp.data.CodeStr ?? cancelResp.data.ErrorMessage ?? ""));
          if (code !== 0 && code !== "0" && !alreadyGone) {
            const message = String(cancelResp.data.CodeStr ?? cancelResp.data.ErrorMessage ?? cancelResp.data.error ?? "星亿娱乐撤单失败");
            return new Response(
              JSON.stringify({ error: message }),
              { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }
        }
      }

      list.splice(foundIdx, 1);
      bets.set(foundSid, list);
      removeBet(betId);
      persistLedgerNow();

      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── 星亿娱乐 (xybet) platform ──
    // XY is a Vue SPA with a REST API. Login flow:
    // 1. POST /api/GraphicsCaptcha/Create → { ImageBase64Str, Data }
    // 2. POST /api/Token/GetGreetins { LoginId, GraphicsCaptcha:{Code,Data} } → { Result, Greetings, GraphicsResult }
    // 3. POST /api/Token/Login { LoginId, Password, GraphicsCaptcha:{Code,Data} } → { Result, Token, ... }

    const XY_BASE = "https://s.xybet00.com";

    async function xyAuthCookies(): Promise<string> {
      const r1 = await lotteryFetch(XY_BASE + "/", {
        headers: { "User-Agent": UA },
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
      });
      const loc1 = r1.headers.get("location") || "/auth?url=%2F";
      const authUrl = loc1.startsWith("http") ? loc1 : XY_BASE + loc1;
      const r2 = await lotteryFetch(authUrl, {
        headers: { "User-Agent": UA, Cookie: parseSetCookie(r1.headers) },
        redirect: "manual",
        signal: AbortSignal.timeout(10000),
      });
      return mergeCookies(parseSetCookie(r1.headers), parseSetCookie(r2.headers));
    }

    async function xyApi(path: string, body: unknown, cookieStr: string, token?: string): Promise<{ data: Record<string, unknown>; cookies: string; status: number; text: string }> {
      const resp = await lotteryFetch(XY_BASE + path, {
        method: "POST",
        headers: {
          "User-Agent": UA,
          "Content-Type": "application/json",
          "X-Requested-With": "XMLHttpRequest",
          Referer: XY_BASE + "/",
          ...(cookieStr ? { Cookie: cookieStr } : {}),
          ...(token ? { Authorization: "Bearer " + token, Token: token } : {}),
        },
        body: JSON.stringify(body ?? {}),
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
      });
      const newCookies = parseSetCookie(resp.headers);
      const merged = mergeCookies(cookieStr, newCookies);
      const text = await resp.text();
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(text); } catch { data = { rawText: text }; }
      return { data, cookies: merged, status: resp.status, text };
    }

    function xyPayload(data: Record<string, unknown>): Record<string, unknown> {
      const inner = data.Data;
      if (inner && typeof inner === "object" && !Array.isArray(inner)) {
        return inner as Record<string, unknown>;
      }
      return data;
    }

    function xyExtractAccessToken(data: Record<string, unknown>): string {
      const fromValue = (value: unknown): string => {
        if (typeof value === "string" && value.length > 8) return value;
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const rec = value as Record<string, unknown>;
          for (const key of ["access_token", "AccessToken", "Token", "token"]) {
            const inner = rec[key];
            if (typeof inner === "string" && inner.length > 8) return inner;
          }
        }
        return "";
      };
      const sources = [data, xyPayload(data)];
      for (const src of sources) {
        for (const key of ["Token", "token", "access_token", "AccessToken"]) {
          const found = fromValue(src[key]);
          if (found) return found;
        }
        const direct = fromValue(src);
        if (direct) return direct;
      }
      return "";
    }

    function pickNumericBalance(obj: unknown, depth = 0): number | null {
      if (obj == null || depth > 8) return null;
      if (typeof obj === "number" && Number.isFinite(obj)) return obj;
      if (typeof obj === "string") {
        const n = Number(obj.replace(/,/g, "").replace(/¥/g, "").trim());
        if (Number.isFinite(n)) return n;
      }
      if (Array.isArray(obj)) {
        for (const item of obj) {
          const found = pickNumericBalance(item, depth + 1);
          if (found != null) return found;
        }
        return null;
      }
      if (typeof obj !== "object") return null;
      const rec = obj as Record<string, unknown>;
      const preferred = [
        "WalletAmount", "walletAmount", "Balance", "balance",
        "Amount", "amount", "Credit", "credit",
        "Money", "AvailableBalance", "MemberBalance",
        "Available", "Cash", "AccountBalance", "Data", "data", "Value", "value",
        "Info", "Member", "member",
      ];
      for (const key of preferred) {
        if (key in rec) {
          const found = pickNumericBalance(rec[key], depth + 1);
          if (found != null) return found;
        }
      }
      for (const value of Object.values(rec)) {
        if (value && typeof value === "object") {
          const found = pickNumericBalance(value, depth + 1);
          if (found != null) return found;
        }
      }
      return null;
    }

    async function xyFetchWalletAmount(cookieStr: string, token: string): Promise<{
      balance: number | null;
      cookies: string;
      debug: { status: number; contentType: string; body: string; tokenLen: number };
    }> {
      const attempts: Array<{ contentType: string; body?: string }> = [
        { contentType: "application/x-www-form-urlencoded; charset=UTF-8", body: "" },
        { contentType: "application/json; charset=utf-8", body: "{}" },
      ];
      let cookies = cookieStr;
      let debug = { status: 0, contentType: "", body: "", tokenLen: token.length };
      for (const attempt of attempts) {
        try {
          const resp = await lotteryFetch(XY_BASE + "/api/Wallet/GetWalletAmount", {
            method: "POST",
            headers: {
              "User-Agent": UA,
              "Content-Type": attempt.contentType,
              Accept: "application/json, text/javascript, */*; q=0.01",
              "X-Requested-With": "XMLHttpRequest",
              Origin: XY_BASE,
              Referer: XY_BASE + "/",
              Authorization: "Bearer " + token,
              ...(cookies ? { Cookie: cookies } : {}),
            },
            body: attempt.body || undefined,
            redirect: "manual",
            signal: AbortSignal.timeout(15000),
          });
          cookies = mergeCookies(cookies, parseSetCookie(resp.headers));
          const text = await resp.text();
          debug = {
            status: resp.status,
            contentType: resp.headers.get("content-type") ?? "",
            body: text.slice(0, 1500),
            tokenLen: token.length,
          };
          let parsed: unknown = text;
          try { parsed = JSON.parse(text); } catch { parsed = text; }
          const balance = pickNumericBalance(parsed);
          if (balance != null && Number.isFinite(balance) && resp.status < 400) {
            return { balance, cookies, debug };
          }
        } catch (err) {
          debug = {
            status: 0,
            contentType: "",
            body: err instanceof Error ? err.message : String(err),
            tokenLen: token.length,
          };
        }
      }
      return { balance: null, cookies, debug };
    }

    async function xyAuthorizedFetch(
      path: string,
      cookieStr: string,
      token: string,
      opts: { method?: string; body?: unknown; referer?: string } = {},
    ) {
      const method = opts.method ?? "POST";
      const referer = opts.referer ?? (XY_BASE + "/");
      const hasBody = method !== "GET" && method !== "HEAD";
      const resp = await lotteryFetch(XY_BASE + path, {
        method,
        headers: {
          "User-Agent": UA,
          Accept: "application/json, text/javascript, */*; q=0.01",
          "X-Requested-With": "XMLHttpRequest",
          Origin: XY_BASE,
          Referer: referer,
          Authorization: "Bearer " + token,
          ...(hasBody ? { "Content-Type": "application/json; charset=utf-8" } : {}),
          ...(cookieStr ? { Cookie: cookieStr } : {}),
        },
        body: hasBody ? JSON.stringify(opts.body ?? {}) : undefined,
        redirect: "manual",
        signal: AbortSignal.timeout(20000),
      });
      const cookies = mergeCookies(cookieStr, parseSetCookie(resp.headers));
      const text = await resp.text();
      let data: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(text) as unknown;
        data = parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed as Record<string, unknown>
          : { Data: parsed };
      } catch {
        data = { rawText: text.slice(0, 800) };
      }
      return { status: resp.status, cookies, data, text };
    }

    function xyAuthorizedPost(path: string, body: unknown, cookieStr: string, token: string, referer?: string) {
      return xyAuthorizedFetch(path, cookieStr, token, { method: "POST", body, referer });
    }

    async function xyRefreshAccessToken(cookieStr: string, token: string): Promise<{ token: string; cookies: string } | null> {
      const paths = ["/api/Token/Refresh", "/api/Token/Renew", "/api/Token/GetToken"];
      let cookies = cookieStr;
      for (const path of paths) {
        try {
          const resp = await xyAuthorizedPost(path, {}, cookies, token, `${XY_BASE}/`);
          cookies = resp.cookies;
          const next = xyExtractAccessToken(resp.data);
          if (next && resp.status < 400) return { token: next, cookies };
        } catch {
          // try next path
        }
      }
      return null;
    }

    function xyMergeSessionToken(
      sessionId: string,
      session: SessionRow,
      cookies: string,
      data: Record<string, unknown>,
      fallbackToken: string,
    ) {
      const next = xyExtractAccessToken(data) || fallbackToken;
      sessions.set(sessionId, { ...session, cookies, login_token: next, authenticated: true });
      persistSessions();
      return next;
    }

    function hyphenIssue(serial: string): string {
      const compact = String(serial).replace(/-/g, "");
      if (compact.length > 8) return `${compact.slice(0, 8)}-${compact.slice(8)}`;
      return String(serial);
    }

    function xyCurrentIssueInfo(data: Record<string, unknown>): { serial: string; closeAt: number | null } {
      const sources = [data, xyPayload(data)];
      for (const src of sources) {
        const current = src.CurrentIssue;
        if (current && typeof current === "object" && !Array.isArray(current)) {
          const rec = current as Record<string, unknown>;
          const serialRaw = rec.SerialNumber ?? rec.serialNumber;
          let serial = "";
          if (typeof serialRaw === "string" && serialRaw) serial = serialRaw;
          else if (typeof serialRaw === "number" && Number.isFinite(serialRaw)) serial = String(serialRaw);
          const closeRaw = rec.CloseTimeStamp ?? rec.closeTimeStamp ?? rec.CloseTime ?? rec.EndTimeStamp;
          let closeAt: number | null = null;
          if (typeof closeRaw === "number" && Number.isFinite(closeRaw)) {
            closeAt = closeRaw < 1e12 ? closeRaw * 1000 : closeRaw;
          } else if (typeof closeRaw === "string" && closeRaw) {
            const n = Number(closeRaw);
            if (Number.isFinite(n)) closeAt = n < 1e12 ? n * 1000 : n;
          }
          if (serial) return { serial, closeAt };
        }
      }
      return { serial: "", closeAt: null };
    }

    if (action === "xycaptcha") {
      const authCookies = await xyAuthCookies();
      const captchaResp = await xyApi("/api/GraphicsCaptcha/Create", {}, authCookies);
      const img = captchaResp.data.ImageBase64Str as string | undefined;
      const captchaData = captchaResp.data.Data as string | undefined;
      if (!img || !captchaData) {
        return new Response(
          JSON.stringify({ error: "无法获取星亿娱乐验证码" }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const xySessionId = crypto.randomUUID();
      sessions.set(xySessionId, {
        id: xySessionId,
        cookies: captchaResp.cookies,
        captcha_de_text: captchaData,
        authenticated: false,
      });
      return new Response(
        JSON.stringify({ sessionId: xySessionId, captchaImage: img }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Step 1: username + captcha → returns greeting text
    if (action === "xystep1") {
      const body = await req.json();
      const { sessionId, loginId, captchaInput } = body as {
        sessionId: string; loginId: string; captchaInput: string;
      };
      const session = sessions.get(sessionId);
      if (!session) {
        return new Response(
          JSON.stringify({ error: "星亿娱乐会话已过期，请刷新验证码" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const greetResp = await xyApi("/api/Token/GetGreetins", {
        LoginId: loginId,
        GraphicsCaptcha: { Code: captchaInput, Data: session.captcha_de_text ?? "" },
        IsGestureLogin: false,
      }, session.cookies ?? "");

      const graphicsResult = greetResp.data.GraphicsResult as number | undefined;
      if (graphicsResult !== undefined && graphicsResult !== 0) {
        return new Response(
          JSON.stringify({ success: false, error: "验证码错误" }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const result = greetResp.data.Result as boolean | undefined;
      if (!result) {
        return new Response(
          JSON.stringify({ success: false, error: "帐号不存在或验证码错误" }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const greeting = (greetResp.data.Greetings as string) || "请确认问候语";
      sessions.set(sessionId, { ...session, cookies: greetResp.cookies, login_id: loginId, captcha_code: captchaInput });
      return new Response(
        JSON.stringify({ success: true, greeting, sessionId }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Step 2: password + confirm greeting → complete login
    if (action === "xystep2") {
      const body = await req.json();
      const { sessionId, password } = body as {
        sessionId: string; password: string;
      };
      const session = sessions.get(sessionId);
      if (!session || !session.login_id) {
        return new Response(
          JSON.stringify({ error: "请先完成第一步验证" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const loginResp = await xyApi("/api/Token/Login", {
        LoginId: session.login_id,
        Password: password,
        GraphicsCaptcha: { Code: session.captcha_code ?? "", Data: session.captcha_de_text ?? "" },
        GooglePassword: "",
      }, session.cookies ?? "");

      const payload = xyPayload(loginResp.data);
      const graphicsResult = (payload.GraphicsResult ?? loginResp.data.GraphicsResult) as number | undefined;
      if (graphicsResult !== undefined && graphicsResult !== 0) {
        return new Response(
          JSON.stringify({ success: false, error: "验证码已过期，请刷新验证码后重试" }),
          { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const result = (payload.Result ?? loginResp.data.Result) as number | undefined;
      const token = xyExtractAccessToken(loginResp.data);
      if (result === 0 || token) {
        let cookies = loginResp.cookies;
        let loginBalance = pickNumericBalance(payload);
        let walletDebug = null as unknown;
        try {
          const wallet = await xyFetchWalletAmount(cookies, token);
          cookies = wallet.cookies;
          walletDebug = wallet.debug;
          if (wallet.balance != null) loginBalance = wallet.balance;
        } catch {
          // login succeeded even if wallet read fails
        }
        sessions.set(sessionId, { ...session, cookies, login_token: token, authenticated: true });
        persistSessions();
        try {
          writeFileSync(
            "/Users/zj/Desktop/时时彩/.xy-wallet-last.json",
            JSON.stringify({
              at: new Date().toISOString(),
              source: "xystep2",
              loginKeys: Object.keys(loginResp.data),
              payloadKeys: Object.keys(payload),
              hasAccessToken: Boolean(token),
              tokenLen: token.length,
              result,
              walletDebug,
            }, null, 2)
          );
        } catch {
          // ignore debug write
        }
        return new Response(
          JSON.stringify({ success: true, sessionId, balance: loginBalance }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const errorMap: Record<number, string> = {
        1: "帐号已停用",
        2: "Token错误",
        3: "请修改默认密码",
        6: "帐号或密码错误",
        7: "短信验证码错误",
        8: "需要Google验证码",
        9: "Google验证码错误",
        15: "帐号已锁定",
        16: "密码过于简单，请修改密码",
      };
      const errorMsg = (result !== undefined && errorMap[result]) || "登录失败，请检查密码";
      return new Response(
        JSON.stringify({ success: false, error: errorMsg }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "xybalance") {
      const body = await req.json();
      const { sessionId } = body as { sessionId: string };
      const session = sessions.get(sessionId);
      if (!session || !session.authenticated) {
        return new Response(
          JSON.stringify({ error: "星亿娱乐会话已过期，请重新登录" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const token = session.login_token ?? "";
      if (!token) {
        return new Response(
          JSON.stringify({ error: "星亿娱乐会话缺少登录令牌，请退出后重新登录" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      try {
        const wallet = await xyFetchWalletAmount(session.cookies ?? "", token);
        sessions.set(sessionId, { ...session, cookies: wallet.cookies });
        try {
          writeFileSync(
            "/Users/zj/Desktop/时时彩/.xy-wallet-last.json",
            JSON.stringify({
              at: new Date().toISOString(),
              source: "xybalance",
              tokenLen: token.length,
              ...wallet.debug,
            }, null, 2)
          );
        } catch {
          // ignore debug write
        }
        if (wallet.balance != null) {
          return new Response(JSON.stringify({ balance: wallet.balance }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        const bodyPreview = wallet.debug.body.replace(/\s+/g, " ").slice(0, 180);
        return new Response(
          JSON.stringify({
            error: `未能读取星亿娱乐账户余额（HTTP ${wallet.debug.status || "?"}，${bodyPreview || "响应为空"}）`,
            debug: wallet.debug,
          }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } catch (err) {
        return new Response(
          JSON.stringify({
            error: "未能读取星亿娱乐账户余额",
            debug: { body: err instanceof Error ? err.message : String(err) },
          }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    if (action === "xyissue") {
      const body = await req.json();
      const { sessionId, lotteryId: lotteryIdRaw } = body as { sessionId: string; lotteryId?: number };
      const lotteryId = resolveLotteryId(lotteryIdRaw);
      const session = sessions.get(sessionId);
      if (!session || !session.authenticated) {
        return new Response(
          JSON.stringify({ error: "星亿娱乐会话已过期，请重新登录" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const token = session.login_token ?? "";
      if (!token) {
        return new Response(
          JSON.stringify({ error: "星亿娱乐会话缺少登录令牌，请退出后重新登录" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const betReferer = `${XY_BASE}/Bet/${lotteryId}`;
      try {
        let tokenNow = token;
        let cookiesNow = session.cookies ?? "";
        let issueInfoResp = await xyAuthorizedPost(
          `/api/Bet/IssueInfo/${lotteryId}`,
          {},
          cookiesNow,
          tokenNow,
          betReferer,
        );
        if (issueInfoResp.status === 401 || issueInfoResp.status === 403) {
          const refreshed = await xyRefreshAccessToken(cookiesNow, tokenNow);
          if (refreshed) {
            tokenNow = refreshed.token;
            cookiesNow = refreshed.cookies;
            issueInfoResp = await xyAuthorizedPost(
              `/api/Bet/IssueInfo/${lotteryId}`,
              {},
              cookiesNow,
              tokenNow,
              betReferer,
            );
          }
        }
        xyMergeSessionToken(sessionId, session, issueInfoResp.cookies, issueInfoResp.data, tokenNow);
        const current = xyCurrentIssueInfo(issueInfoResp.data);
        if (!current.serial) {
          return new Response(
            JSON.stringify({ error: issueInfoResp.status === 401 || issueInfoResp.status === 403
              ? "星亿娱乐登录已过期，请重新登录"
              : "未能读取星亿娱乐当前期号" }),
            { status: issueInfoResp.status === 401 || issueInfoResp.status === 403 ? 401 : 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        return new Response(
          JSON.stringify({
            issue: hyphenIssue(current.serial),
            closeAt: current.closeAt,
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } catch (err) {
        return new Response(
          JSON.stringify({ error: err instanceof Error ? err.message : "读取星亿当前期号失败" }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    if (action === "xybet") {
      const body = await req.json();
      const { sessionId, lotteryId: lotteryIdRaw, issue: issueRaw, picks, betAmount, position } = body as {
        sessionId: string; lotteryId: number; issue: string; picks: number[]; betAmount: number; position?: number;
      };
      const lotteryId = resolveLotteryId(lotteryIdRaw);
      let issue = issueRaw;
      const betPosition = position >= 1 && position <= 5 ? Math.round(position) : 5;
      const betReferer = `${XY_BASE}/Bet/${lotteryId}`;

      if (!sessionId || !lotteryIdRaw || !issue || !Array.isArray(picks) || picks.length === 0 || !betAmount) {
        return new Response(
          JSON.stringify({ error: "参数不完整" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const session = sessions.get(sessionId);
      if (!session || !session.authenticated) {
        return new Response(
          JSON.stringify({ error: "星亿娱乐会话已过期，请重新登录" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (!memberForSession(session)) {
        return new Response(
          JSON.stringify({ error: "当前星亿账号未绑定会员，无法投注" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const token = session.login_token ?? "";
      if (!token) {
        return new Response(
          JSON.stringify({ error: "星亿娱乐会话缺少登录令牌，请退出后重新登录" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      let cookies = session.cookies ?? "";
      try {
        const gameInfoResp = await xyAuthorizedFetch(
          `/api/Bet/GameInfo/${lotteryId}`,
          cookies,
          token,
          { method: "GET", referer: betReferer },
        );
        cookies = gameInfoResp.cookies;
        const issueInfoResp = await xyAuthorizedPost(
          `/api/Bet/IssueInfo/${lotteryId}`,
          {},
          cookies,
          token,
          betReferer,
        );
        cookies = issueInfoResp.cookies;
        const userGameResp = await xyAuthorizedPost(
          `/api/Bet/UserGameInfo/${lotteryId}`,
          {},
          cookies,
          token,
          betReferer,
        );
        cookies = userGameResp.cookies;

        const gameInfo = { ...gameInfoResp.data, ...xyPayload(gameInfoResp.data) };
        if (gameInfo.Offline === true || gameInfo.IsOfficialOffline === true || gameInfo.IsMaintain === true) {
          return new Response(
            JSON.stringify({ error: `星亿娱乐该彩种当前不可投注（游戏 ${lotteryId}）` }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        const currentIssue = xyCurrentIssueInfo(issueInfoResp.data);
        if (currentIssue.serial) {
          issue = hyphenIssue(currentIssue.serial);
        } else if (issueInfoResp.status < 400 && !issueInfoResp.data.rawText) {
          return new Response(
            JSON.stringify({ error: "星亿娱乐该彩种当前暂停下注" }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      } catch {
        // 进厅失败时仍用前端传来的期号尝试投注
      }

      const xyDedupeKey = betDedupeKey(sessionId, lotteryId, issue);
      if (
        placingBetKeys.has(xyDedupeKey) ||
        hasPendingBet(sessionId, lotteryId, issue) ||
        hasPendingBet(sessionId, lotteryId, String(issueRaw))
      ) {
        return new Response(
          JSON.stringify({ success: true, duplicate: true, lotteryId, issue }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      placingBetKeys.add(xyDedupeKey);
      try {
      const serialNumber = String(issue).replace(/-/g, "");
      const guid = generateBetGuid();
      const unit = 1;
      const multiple = Math.max(1, Math.round(Number(betAmount) / unit));
      const slotNumber = (digits: number[]) => {
        const slots = ["", "", "", "", ""];
        slots[betPosition - 1] = [...digits].sort((a, b) => a - b).join("");
        return slots.join(",");
      };
      const betData = {
        LotteryGameID: lotteryId,
        SerialNumber: serialNumber,
        IsLoginByWeChat: false,
        Guid: guid,
        BetMode: 0,
        BetGuid: "",
        LionKingBetID: 0,
        Bets: [{
          BetTypeCode: 21,
          Number: slotNumber(picks.map((n) => Number(n))),
          IsCompressed: false,
          Position: String(betPosition),
          Unit: unit,
          Multiple: multiple,
          ReturnRate: 0,
        }],
      };

      let betResp;
      try {
        betResp = await xyAuthorizedPost("/api/Bet/Confirm", betData, cookies, token, betReferer);
      } catch (err) {
        return new Response(
          JSON.stringify({ error: err instanceof Error ? err.message : "星亿娱乐投注请求失败" }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      sessions.set(sessionId, { ...session, cookies: betResp.cookies });
      cookies = betResp.cookies;

      const firstError = typeof betResp.data.ErrorMessage === "string" ? betResp.data.ErrorMessage : "";
      if (betResp.data.Success !== true && /非当前期号|已关盘|关盘/.test(firstError)) {
        try {
          const refresh = await xyAuthorizedPost(`/api/Bet/IssueInfo/${lotteryId}`, {}, cookies, token, betReferer);
          cookies = refresh.cookies;
          const fresh = xyCurrentIssueInfo(refresh.data);
          if (fresh.serial && !issuesMatch(fresh.serial, String(issue))) {
            issue = hyphenIssue(fresh.serial);
            betData.SerialNumber = String(issue).replace(/-/g, "");
            betResp = await xyAuthorizedPost("/api/Bet/Confirm", betData, cookies, token, betReferer);
            sessions.set(sessionId, { ...session, cookies: betResp.cookies });
          }
        } catch {
          // keep original confirm result
        }
      }

      if (betResp.status === 401 || betResp.status === 403) {
        return new Response(
          JSON.stringify({ error: "星亿娱乐登录已过期，请重新登录" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (typeof betResp.data.rawText === "string") {
        return new Response(
          JSON.stringify({ error: "星亿娱乐投注接口返回异常，请稍后重试" }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const success = betResp.data.Success === true;
      const errorMessage = typeof betResp.data.ErrorMessage === "string" ? betResp.data.ErrorMessage : "";
      if (!success) {
        return new Response(
          JSON.stringify({ error: errorMessage || `星亿娱乐投注失败（HTTP ${betResp.status}）` }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const remoteSource = betResp.data.Bets ?? xyPayload(betResp.data).Bets;
      const remote_ids: string[] = [];
      if (Array.isArray(remoteSource)) {
        for (const item of remoteSource) {
          if (!item || typeof item !== "object") continue;
          const rec = item as Record<string, unknown>;
          for (const key of ["ID", "Id", "id", "BetID"]) {
            const value = rec[key];
            if (typeof value === "string" && value) remote_ids.push(value);
            else if (typeof value === "number" && Number.isFinite(value)) remote_ids.push(String(value));
          }
        }
      }

      const betId = crypto.randomUUID();
      const totalCost = betAmount * picks.length;
      const bet: BetRow = withMemberId({
        id: betId, session_id: sessionId, lottery_id: lotteryId, issue, picks,
        bet_amount: betAmount, total_cost: totalCost, status: "pending",
        result_number: null, payout: 0, net: 0, position: betPosition,
        created_at: new Date().toISOString(), settled_at: null,
        remote_ids: [...new Set(remote_ids)],
      }, session);
      if (!bets.has(sessionId)) bets.set(sessionId, []);
      bets.get(sessionId)!.push(bet);
      upsertBet(bet);
      return new Response(
        JSON.stringify({ success: true, betId, lotteryId, issue, walletAmount: betResp.data.WalletAmount }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
      } finally {
        placingBetKeys.delete(xyDedupeKey);
      }
    }

    if (action === "betdays") {
      const body = (await req.json().catch(() => ({}))) as { sessionId?: string };
      const member = memberForSessionId(body.sessionId);
      return new Response(
        JSON.stringify({
          days: member ? dailySummary(member.id) : [],
          rebatePerTurnover: 10000,
          rebateAmount: 475,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "betdays-clear") {
      const body = await req.json().catch(() => ({})) as { password?: string; sessionId?: string };
      if (String(body.password ?? "") !== "138654") {
        return new Response(
          JSON.stringify({ error: "密码错误，无法清空" }),
          { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      const member = memberForSessionId(body.sessionId);
      if (!member) {
        return new Response(
          JSON.stringify({ error: "找不到对应会员账本" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      for (const [sid, list] of bets) {
        bets.set(sid, list.filter((item) => item.member_id !== member.id));
      }
      clearLedger(member.id);
      return new Response(
        JSON.stringify({ success: true, days: [] }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Unknown action: " + action }),
      {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: describeFetchError(err) }),
      {
        status: 502,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
}

setProxyCall(async (action, body) => {
  const resp = await handleLotteryProxy(
    new Request(`http://127.0.0.1/api/lottery?action=${encodeURIComponent(action)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body ?? {}),
    }),
  );
  const data = (await resp.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: resp.status, data };
}, (sessionId) => sessions.get(sessionId));

ensureTelegramPoller();

