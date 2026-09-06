/** Local lottery proxy. Sessions live in memory for this Node process; no Supabase. */

import { Buffer } from "node:buffer";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import type { Dispatcher } from "undici";

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

interface SessionRow {
  id: string;
  cookies: string;
  form_token: string | null;
  captcha_de_text: string | null;
  authenticated: boolean;
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
}

const sessions = new Map<string, SessionRow>();
const bets = new Map<string, BetRow[]>();

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
    Referer: LOTTERY_BASE + "/",
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
        });

        return new Response(
          JSON.stringify({ success: true, sessionId }),
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
      const { sessionId, lotteryId, issue, picks, betAmount } = body as {
        sessionId: string;
        lotteryId: number;
        issue: string;
        picks: number[];
        betAmount: number;
      };

      if (!sessionId || !lotteryId || !issue || !Array.isArray(picks) || picks.length === 0 || !betAmount) {
        return new Response(
          JSON.stringify({ error: "参数不完整" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const existing = bets.get(sessionId)?.find((b) => b.issue === issue);
      if (existing) {
        return new Response(
          JSON.stringify({ error: "该期已存在投注记录" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const betId = crypto.randomUUID();
      const totalCost = betAmount * picks.length;
      const bet: BetRow = {
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
        created_at: new Date().toISOString(),
        settled_at: null,
      };

      if (!bets.has(sessionId)) bets.set(sessionId, []);
      bets.get(sessionId)!.push(bet);

      return new Response(
        JSON.stringify({ success: true, betId }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "betlist") {
      const body = await req.json();
      const { sessionId, lotteryId, status } = body as {
        sessionId: string;
        lotteryId?: number;
        status?: string;
      };

      let list = bets.get(sessionId) ?? [];
      if (lotteryId) list = list.filter((b) => b.lottery_id === lotteryId);
      if (status) list = list.filter((b) => b.status === status);
      list = [...list].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? "")).slice(0, 200);

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

      const ODDS = 9.77;
      let settledCount = 0;
      const sessionBets = bets.get(sessionId) ?? [];

      for (const draw of draws) {
        const resultNumber = draw.numbers[4];
        const issueKey = draw.issue.includes("-")
          ? draw.issue
          : draw.issue.slice(0, 8) + "-" + draw.issue.slice(8);

        for (const bet of sessionBets) {
          if (bet.status !== "pending") continue;
          if (bet.issue !== draw.issue && bet.issue !== issueKey) continue;

          const hit = bet.picks.includes(resultNumber);
          const payout = hit ? bet.bet_amount * ODDS : 0;
          const net = payout - bet.total_cost;
          bet.status = hit ? "won" : "lost";
          bet.result_number = resultNumber;
          bet.payout = payout;
          bet.net = net;
          bet.settled_at = new Date().toISOString();
          settledCount++;
        }
      }

      return new Response(
        JSON.stringify({ success: true, settledCount }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "betdelete") {
      const body = await req.json();
      const { betId } = body as { betId: string };

      if (!betId) {
        return new Response(
          JSON.stringify({ error: "缺少投注ID" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      for (const [sid, list] of bets.entries()) {
        const idx = list.findIndex((b) => b.id === betId);
        if (idx >= 0) {
          list.splice(idx, 1);
          bets.set(sid, list);
          break;
        }
      }

      return new Response(
        JSON.stringify({ success: true }),
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
