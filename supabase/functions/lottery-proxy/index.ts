// Lottery proxy edge function — real bet submission
import { createClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const LOTTERY_BASE = "https://sk.jhc3ejo8.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

interface SessionRow {
  id: string;
  cookies: string;
  created_at: string;
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
    new RegExp(`(?:name|id)=["']${name}["'][^>]*value=["']([^"']*)["']`, "i"),
    new RegExp(`value=["']([^"']*)["'][^>]*(?:name|id)=["']${name}["']`, "i"),
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
    Referer: LOTTERY_BASE + "/",
    ...options.headers,
  };
  if (options.body && !reqHeaders["Content-Type"]) {
    reqHeaders["Content-Type"] = "application/x-www-form-urlencoded";
  }

  const resp = await fetch(url, {
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
    const issueMatch = plainRow.match(/\d{8}-\d{1,3}/);
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
  const issueRegex = /\d{8}-\d{1,3}/g;
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
    let numberTokens = afterIssue.match(/(?<!\d)\d(?!\d)/g) ?? [];
    if (numberTokens.length < 5) {
      const numberClasses = fragment.match(
        /(?:num|number|ball|lottery)[-_]?(?:n|num)?([0-9])/gi
      ) ?? [];
      numberTokens = numberClasses
        .map((value) => value.match(/([0-9])$/)?.[1] ?? "")
        .filter(Boolean);
    }
    if (numberTokens.length < 5) {
      numberTokens = fragment.match(/data-(?:number|value)=["']([0-9])["']/gi)?.map(
        (value) => value.match(/([0-9])["']$/)?.[1] ?? ""
      ).filter(Boolean) ?? numberTokens;
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
            if (/^\d{8}-\d{1,3}/.test(issue) && numbers.every((n) => n >= 0 && n <= 9)) {
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
    if (!/^\d{8}\d{1,3}$/.test(issue)) continue;
    const numbers = parts.slice(1, 6).map((n) => parseInt(n, 10));
    if (numbers.some((n) => isNaN(n) || n < 0 || n > 9)) continue;
    const timeMatch = issueStr.match(/\d{2}:\d{2}/);
    results.push({ issue, time: timeMatch ? timeMatch[0] : "", numbers });
  }

  return results;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const action = url.searchParams.get("action") ?? "captcha";

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const SESSION_TABLE = "lottery_sessions";

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
      const captchaImgResp = await fetch(
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
      let binary = "";
      const chunk = 0x8000;
      for (let i = 0; i < imgBytes.length; i += chunk) {
        binary += String.fromCharCode(...imgBytes.subarray(i, i + chunk));
      }
      const imgBase64 = btoa(binary);
      const contentType = captchaImgResp.headers.get("content-type")?.split(";")[0].trim() || "image/gif";

      // Store session in Supabase
      const sessionId = crypto.randomUUID();
      await supabase.from(SESSION_TABLE).insert({
        id: sessionId,
        cookies: captchaFrag.cookies,
        form_token: formToken,
        captcha_de_text: captchaDeText,
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

      const { data: session, error: sessionError } = await supabase
        .from(SESSION_TABLE)
        .select("*")
        .eq("id", sessionId)
        .maybeSingle();

      if (sessionError || !session) {
        return new Response(
          JSON.stringify({ error: "会话已过期，请刷新验证码" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      const row = session as SessionRow & {
        form_token: string;
        captcha_de_text: string;
      };
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
          LOTTERY_BASE + "/DrawHistory/Trend/128?issue=5&day=0",
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
        await supabase
          .from(SESSION_TABLE)
          .update({ cookies: finalCookies, authenticated: true })
          .eq("id", sessionId);

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
      const { sessionId, issueCount } = body as { sessionId: string; issueCount?: number };
      const issueLimit = Math.min(100, Math.max(1, Number(issueCount) || 100));

      const { data: session, error: sessionError } = await supabase
        .from(SESSION_TABLE)
        .select("*")
        .eq("id", sessionId)
        .maybeSingle();

      if (sessionError || !session) {
        return new Response(
          JSON.stringify({ error: "会话已过期，请重新登录" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      const cookies = (session as SessionRow).cookies;

      const requestedLotteryId = Number((body as { lotteryId?: number }).lotteryId);
      const lotteryId = [60, 127, 128].includes(requestedLotteryId) ? requestedLotteryId : 128;
      const trendUrl =
        LOTTERY_BASE + `/DrawHistory/Trend/${lotteryId}?issue=${issueLimit}&day=0`;

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

      await supabase
        .from(SESSION_TABLE)
        .update({ cookies: currentCookies })
        .eq("id", sessionId);

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
      const lotteryId = Number(lotteryIdRaw) || 128;

      const { data: session } = await supabase
        .from(SESSION_TABLE)
        .select("*")
        .eq("id", sessionId)
        .maybeSingle();

      if (!session) {
        return new Response(
          JSON.stringify({ error: "no session" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const cookies = (session as SessionRow).cookies;
      const pageUrl = LOTTERY_BASE + "/Bet/Index?gid=" + lotteryId;
      const pageResp = await fetchWithCookies(pageUrl, cookies, { redirect: "manual" });
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

      await supabase
        .from(SESSION_TABLE)
        .update({ cookies: currentCookies })
        .eq("id", sessionId);

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
      const { sessionId } = body as { sessionId: string };

      const { data: session } = await supabase
        .from(SESSION_TABLE)
        .select("*")
        .eq("id", sessionId)
        .maybeSingle();

      if (!session) {
        return new Response(
          JSON.stringify({ error: "no session" }),
          {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          }
        );
      }

      const cookies = (session as SessionRow).cookies;
      const trendUrl = LOTTERY_BASE + "/DrawHistory/Trend/128?issue=100&day=0";
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

    if (action === "betdebug") {
      const body = await req.json();
      const { sessionId, lotteryId: lotteryIdRaw } = body as {
        sessionId: string;
        lotteryId?: number;
      };
      const lotteryId = Number(lotteryIdRaw) || 128;

      const { data: session } = await supabase
        .from(SESSION_TABLE)
        .select("*")
        .eq("id", sessionId)
        .maybeSingle();

      if (!session) {
        return new Response(
          JSON.stringify({ error: "no session" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const cookies = (session as SessionRow).cookies;
      const pageUrl = LOTTERY_BASE + "/Bet/Index?gid=" + lotteryId;
      const pageResp = await fetchWithCookies(pageUrl, cookies, { redirect: "manual" });
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

      const html = pageResp.text;
      const isLoginPage = /ErrorHandle\/Timeout|top\.location\.href/i.test(html);

      // Extract all <script src="..."> references
      const scriptSrcs: string[] = [];
      const srcRegex = /<script[^>]+src=["']([^"']+)["']/gi;
      let srcMatch: RegExpExecArray | null;
      while ((srcMatch = srcRegex.exec(html)) !== null) {
        scriptSrcs.push(srcMatch[1]);
      }

      // Extract inline scripts that mention bet/confirm/submit
      const inlineScripts: string[] = [];
      const scriptRegex = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
      let scriptMatch: RegExpExecArray | null;
      while ((scriptMatch = scriptRegex.exec(html)) !== null) {
        const code = scriptMatch[1].trim();
        if (code.length === 0) continue;
        // Only keep scripts that mention bet-related keywords
        if (/bet|confirm|submit|ajax|post|Bet\/|SerialNumber|LotteryGameID|tgid|guid/i.test(code)) {
          inlineScripts.push(code);
        }
      }

      // Extract all form elements
      const forms: { action: string; method: string; inputs: { name: string; value: string }[] }[] = [];
      const formRegex = /<form[^>]*>/gi;
      let formMatch: RegExpExecArray | null;
      while ((formMatch = formRegex.exec(html)) !== null) {
        const formTag = formMatch[0];
        const actionMatch = formTag.match(/action=["']([^"']*)["']/i);
        const methodMatch = formTag.match(/method=["']([^"']*)["']/i);
        const formStart = formMatch.index ?? 0;
        const formEnd = html.indexOf("</form>", formStart);
        const formHtml = formEnd > 0 ? html.slice(formStart, formEnd) : html.slice(formStart, formStart + 2000);
        const inputs: { name: string; value: string }[] = [];
        const inputRegex = /<(?:input|select|textarea)[^>]*name=["']([^"']+)["'][^>]*value=["']([^"']*)["']/gi;
        let inputMatch: RegExpExecArray | null;
        while ((inputMatch = inputRegex.exec(formHtml)) !== null) {
          inputs.push({ name: inputMatch[1], value: inputMatch[2] });
        }
        forms.push({
          action: actionMatch?.[1] ?? "",
          method: methodMatch?.[1] ?? "get",
          inputs,
        });
      }

      // Extract hidden inputs (anti-forgery tokens etc.)
      const hiddenInputs: { name: string; value: string; id: string }[] = [];
      const hiddenRegex = /<input[^>]*type=["']hidden["'][^>]*>/gi;
      let hiddenMatch: RegExpExecArray | null;
      while ((hiddenMatch = hiddenRegex.exec(html)) !== null) {
        const tag = hiddenMatch[0];
        const nameMatch = tag.match(/name=["']([^"']+)["']/i);
        const valueMatch = tag.match(/value=["']([^"']*)["']/i);
        const idMatch = tag.match(/id=["']([^"']+)["']/i);
        if (nameMatch) {
          hiddenInputs.push({
            name: nameMatch[1],
            value: valueMatch?.[1] ?? "",
            id: idMatch?.[1] ?? "",
          });
        }
      }

      // Find any data-* attributes on bet-related elements
      const dataAttrs: string[] = [];
      const dataRegex = /data-(?:url|action|api|bet|game|issue|serial)[^=]*=["']([^"']+)["']/gi;
      let dataMatch: RegExpExecArray | null;
      while ((dataMatch = dataRegex.exec(html)) !== null) {
        dataAttrs.push(dataMatch[0]);
      }

      return new Response(
        JSON.stringify({
          status: pageResp.status,
          length: html.length,
          isLoginPage,
          scriptSrcs,
          inlineScriptsCount: inlineScripts.length,
          inlineScripts,
          forms,
          hiddenInputs,
          dataAttrs,
          htmlHead: html.slice(0, 3000),
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

      const { data: session } = await supabase
        .from(SESSION_TABLE)
        .select("*")
        .eq("id", sessionId)
        .maybeSingle();

      if (!session) {
        return new Response(
          JSON.stringify({ error: "会话已过期，请重新登录" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const cookies = (session as SessionRow).cookies;

      // Step 1: Load the bet page first to establish session state and get anti-forgery token
      const betPageUrl = LOTTERY_BASE + "/Bet/Index?gid=" + lotteryId;
      const betPageResp = await fetchWithCookies(betPageUrl, cookies, { redirect: "manual" });
      let betPageCookies = betPageResp.cookies;
      for (let i = 0; i < 8; i++) {
        if (betPageResp.status < 300 || betPageResp.status >= 400) break;
        const location = betPageResp.headers.get("location");
        if (!location) break;
        const redirectUrl = location.startsWith("http")
          ? location
          : LOTTERY_BASE + (location.startsWith("/") ? location : "/" + location);
        const next = await fetchWithCookies(redirectUrl, betPageCookies, { redirect: "manual" });
        betPageCookies = next.cookies;
        break;
      }

      const isBetPageLogin = /ErrorHandle\/Timeout|top\.location\.href/i.test(betPageResp.text);
      if (isBetPageLogin) {
        return new Response(
          JSON.stringify({ error: "登录已过期，请重新登录" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Extract anti-forgery token from the bet page
      const betFormToken = getFormField(betPageResp.text, "__RequestVerificationToken");

      // Extract the real internal lotteryGameId from the page (gid in URL is just navigation)
      const gameIdMatch = betPageResp.text.match(/lotteryGameId\s*=\s*(\d+)/);
      const realGameId = gameIdMatch ? parseInt(gameIdMatch[1], 10) : 1;

      // Persist updated cookies back to the session
      await supabase
        .from(SESSION_TABLE)
        .update({ cookies: betPageCookies })
        .eq("id", sessionId);

      const serialNumber = issue.replace("-", "");
      const guid = generateBetGuid();
      const unit = 2;
      const multiple = Math.max(1, Math.round(betAmount / unit));

      const betData = {
        LotteryGameID: realGameId,
        SerialNumber: serialNumber,
        Bets: picks.map((n) => ({
          BetTypeCode: 21,
          BetTypeName: "",
          Number: String(n),
          Position: "5",
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

      if (betResp.status !== 200) {
        const targetMessage = betResp.text
          .replace(/<script[\s\S]*?<\/script>/gi, " ")
          .replace(/<style[\s\S]*?<\/style>/gi, " ")
          .replace(/<[^>]*>/g, " ")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 500);
        return new Response(
          JSON.stringify({
            error: targetMessage
              ? `目标网站拒绝投注（${betResp.status}）：${targetMessage}`
              : `目标网站拒绝投注（状态 ${betResp.status}）`,
            debug: {
              status: betResp.status,
              rawResponse: betResp.text.slice(0, 1000),
              sentBetData: betData,
              serialNumber,
            },
          }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const isLoginRedirect = /ErrorHandle\/Timeout|top\.location\.href/i.test(betResp.text);
      if (isLoginRedirect) {
        return new Response(
          JSON.stringify({ error: "登录已过期，请重新登录" }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      let betResult: Record<string, unknown> | null = null;
      try {
        betResult = JSON.parse(betResp.text);
      } catch {
        return new Response(
          JSON.stringify({
            error: "目标网站未返回有效确认，投注可能未提交",
            debug: { raw: betResp.text.slice(0, 500), sentBetData: betData },
          }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      if (typeof betResult !== "object" || betResult === null) {
        return new Response(
          JSON.stringify({ error: "目标网站返回格式异常", betResult }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const errMsg = (betResult as Record<string, unknown>).ErrorMessage;
      if (typeof errMsg === "string" && errMsg) {
        return new Response(
          JSON.stringify({ error: errMsg }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const br = betResult as Record<string, unknown>;
      const siteConfirmed =
        br.Success === true ||
        br.success === true ||
        br.Code === 0 || br.Code === 200 ||
        br.code === 0 || br.code === 200 ||
        br.Status === 0 || br.status === 0 ||
        br.IsSuccess === true;

      if (!siteConfirmed) {
        return new Response(
          JSON.stringify({
            error: "目标网站未确认投注成功，请到网站核实",
            debug: { betResult, sentBetData: betData },
          }),
          { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      const totalCost = betAmount * picks.length;
      const { data, error } = await supabase
        .from("lottery_bets")
        .insert({
          session_id: sessionId,
          lottery_id: lotteryId,
          issue,
          picks,
          bet_amount: betAmount,
          total_cost: totalCost,
          status: "pending",
        })
        .select("id")
        .single();

      if (error) {
        return new Response(
          JSON.stringify({ error: "投注记录保存失败: " + error.message, betResult }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({ success: true, betId: data.id, betResult }),
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

      let query = supabase.from("lottery_bets").select("*").eq("session_id", sessionId);
      if (lotteryId) query = query.eq("lottery_id", lotteryId);
      if (status) query = query.eq("status", status);
      query = query.order("created_at", { ascending: false }).limit(200);

      const { data, error } = await query;

      if (error) {
        return new Response(
          JSON.stringify({ error: "获取投注记录失败: " + error.message }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({ bets: data ?? [] }),
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

      for (const draw of draws) {
        const resultNumber = draw.numbers[4];
        const issueKey = draw.issue.includes("-")
          ? draw.issue
          : draw.issue.slice(0, 8) + "-" + draw.issue.slice(8);

        const { data: pendingBets } = await supabase
          .from("lottery_bets")
          .select("*")
          .eq("session_id", sessionId)
          .eq("status", "pending")
          .or(`issue.eq.${draw.issue},issue.eq.${issueKey}`);

        if (!pendingBets || pendingBets.length === 0) continue;

        for (const bet of pendingBets) {
          const hit = bet.picks.includes(resultNumber);
          const payout = hit ? Number(bet.bet_amount) * ODDS : 0;
          const net = payout - Number(bet.total_cost);

          await supabase
            .from("lottery_bets")
            .update({
              status: hit ? "won" : "lost",
              result_number: resultNumber,
              payout,
              net,
              settled_at: new Date().toISOString(),
            })
            .eq("id", bet.id);

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

      await supabase.from("lottery_bets").delete().eq("id", betId);

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
      JSON.stringify({ error: err instanceof Error ? err.message : String(err) }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
