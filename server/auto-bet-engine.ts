import { nextMartingaleState, stakeWithMultiplier } from "../src/martingale.ts";
import { findMemberByAoshi, findMemberById } from "./members";
import { loadPersistedJobs, savePersistedJobs } from "./runtime-store";
import { alertMemberLoginExpired, isLoginExpiredError } from "./telegram";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

type Bet = { issue: string; status: string; created_at?: string };
type Draw = { issue: string; numbers: number[]; time?: string };

export type AutoBetConfig = {
  memberId: string;
  platform: "aoshi" | "xingyi";
  sessionId: string;
  xySessionId?: string | null;
  lotteryId: number;
  position: number;
  windowSize: number;
  pickCount: number;
  excludeLast: boolean;
  betAmount: number;
  martingaleOn: boolean;
  martingaleFactor: number;
  martingaleReset: number;
};

type Job = AutoBetConfig & {
  enabled: boolean;
  lastBetIssue: string | null;
  scheduledIssue: string | null;
  scheduledAt: number | null;
  liveIssue: string | null;
  closeAt: number | null;
  lastError: string;
  lastPicks: number[];
  placing: boolean;
};

type ProxyCall = (action: string, body: unknown) => Promise<{ status: number; data: Record<string, unknown> }>;
type SessionLookup = (sessionId: string) => { login_id?: string } | undefined;

const g = globalThis as typeof globalThis & {
  __sscAutoBet?: {
    jobs: Map<string, Job>;
    timer: ReturnType<typeof setInterval> | null;
    call: ProxyCall | null;
    getSession: SessionLookup | null;
    tick: (() => Promise<void>) | null;
  };
};

function store() {
  const existing = g.__sscAutoBet as (typeof g.__sscAutoBet) & { job?: Job | null };
  if (!existing || !existing.jobs) {
    const jobs = new Map<string, Job>();
    if (existing?.job?.memberId) jobs.set(existing.job.memberId, existing.job);
    g.__sscAutoBet = {
      jobs,
      timer: existing?.timer ?? null,
      call: existing?.call ?? null,
      getSession: existing?.getSession ?? null,
      tick: existing?.tick ?? null,
    };
  }
  return g.__sscAutoBet!;
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function issueSeq(issue: string): { day: string; seq: number } | null {
  const compact = String(issue).replace(/-/g, "");
  if (compact.length <= 8) return null;
  const seq = Number.parseInt(compact.slice(8), 10);
  if (!Number.isFinite(seq)) return null;
  return { day: compact.slice(0, 8), seq };
}

function issueEarlier(a: string, b: string): boolean {
  const left = issueSeq(a);
  const right = issueSeq(b);
  if (!left || !right) return a.replace(/-/g, "") < b.replace(/-/g, "");
  if (left.day !== right.day) return left.day < right.day;
  return left.seq < right.seq;
}

function sameIssue(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return String(a).replace(/-/g, "") === String(b).replace(/-/g, "");
}

function nextIssue(issue: string): string | null {
  const hyphenated = issue.match(/^(\d{8})-(\d{1,4})$/);
  const compact = issue.match(/^(\d{8})(\d{1,4})$/);
  const match = hyphenated ?? compact;
  if (!match) return null;
  const seqStr = match[2];
  const width = seqStr.length;
  const sequence = Number.parseInt(seqStr, 10) + 1;
  return `${match[1]}-${String(sequence).padStart(width, "0")}`;
}

function gamePeriodMs(gameId: number): number {
  if (gameId === 60) return 60_000;
  if (gameId === 127) return 5 * 60_000;
  return 10 * 60_000;
}

function parseDrawTimeMs(draw?: { issue: string; time?: string } | null): number | null {
  if (!draw) return null;
  const time = draw.time?.trim() ?? "";
  const full = time.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(?::(\d{2}))?/);
  if (full) {
    const ms = Date.parse(`${full[1]}T${full[2]}:${full[3] ?? "00"}`);
    return Number.isFinite(ms) ? ms : null;
  }
  const clock = time.match(/^(\d{2}:\d{2})(?::(\d{2}))?$/);
  const issueDate = String(draw.issue).replace(/-/g, "").match(/^(\d{4})(\d{2})(\d{2})/);
  if (clock && issueDate) {
    const ms = Date.parse(`${issueDate[1]}-${issueDate[2]}-${issueDate[3]}T${clock[1]}:${clock[2] ?? "00"}`);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function randomBetDelayMs(gameId: number, lastDraw?: Draw | null, closeAt?: number | null): number {
  const period = gamePeriodMs(gameId);
  const closeBuffer = gameId === 60 ? 3_000 : gameId === 127 ? 6_000 : 8_000;
  const minWait = gameId === 60 ? 2_000 : 5_000;
  const now = Date.now();
  const drawnAt = parseDrawTimeMs(lastDraw);
  const windowEnd = (closeAt && closeAt > now ? closeAt : (drawnAt ?? now) + period) - closeBuffer;
  const maxWait = windowEnd - now;
  if (maxWait <= 0) return 0;
  if (maxWait <= minWait) return Math.min(800, maxWait);
  return minWait + Math.floor(Math.random() * (maxWait - minWait));
}

function computePicksFromHistory(
  history: Draw[],
  pickCount: number,
  excludeLast: boolean,
  position: number,
): number[] {
  const geCounts = new Array(10).fill(0);
  const transition: number[][] = Array.from({ length: 10 }, () => new Array(10).fill(0));
  let prevGe = -1;
  for (const draw of history) {
    const digit = draw.numbers[position - 1];
    if (typeof digit !== "number") continue;
    geCounts[digit]++;
    if (prevGe >= 0) transition[prevGe][digit]++;
    prevGe = digit;
  }
  const maxHot = Math.max(...geCounts) || 1;
  let transScore = new Array(10).fill(0);
  if (prevGe >= 0) {
    const row = transition[prevGe];
    const maxT = Math.max(...row);
    if (maxT > 0) transScore = row.map((c) => (c / maxT) * 100);
  }
  const scores = new Array(10).fill(0);
  for (let n = 0; n < 10; n++) {
    scores[n] = (geCounts[n] / maxHot) * 55 + transScore[n] * 45;
  }
  return scores
    .map((s, n) => ({ s, n }))
    .filter(({ n }) => !excludeLast || n !== prevGe)
    .sort((a, b) => b.s - a.s)
    .slice(0, pickCount)
    .map((x) => x.n)
    .sort((a, b) => a - b);
}

function jobSnapshot(job: Job | null) {
  if (!job) {
    return { running: false, enabled: false };
  }
  return {
    running: job.enabled,
    enabled: job.enabled,
    memberId: job.memberId,
    platform: job.platform,
    lotteryId: job.lotteryId,
    lastBetIssue: job.lastBetIssue,
    issue: job.liveIssue,
    closeAt: job.closeAt,
    scheduledAt: job.scheduledAt,
    lastError: job.lastError,
    lastPicks: job.lastPicks,
    placing: job.placing,
    position: job.position,
    betAmount: job.betAmount,
  };
}

function ensureTimer() {
  const s = store();
  s.tick = tick;
  if (s.timer) return;
  s.timer = setInterval(() => {
    void store().tick?.();
  }, 1000);
}

export function setProxyCall(call: ProxyCall, getSession?: SessionLookup) {
  const s = store();
  s.call = call;
  if (getSession) s.getSession = getSession;
  ensureTimer();
  const saved = loadPersistedJobs();
  for (const item of saved) {
    if (!item.memberId || !findMemberById(item.memberId)) continue;
    if (item.enabled && !s.jobs.get(item.memberId)?.enabled) {
      startJob(item);
      const current = s.jobs.get(item.memberId);
      if (current) current.lastBetIssue = item.lastBetIssue;
    }
  }
}

function parseConfig(body: Record<string, unknown>): AutoBetConfig | string {
  const platform = body.platform === "aoshi" ? "aoshi" : "xingyi";
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  const xySessionId = typeof body.xySessionId === "string" ? body.xySessionId : null;
  const lotteryId = Number(body.lotteryId);
  const position = Number(body.position);
  const windowSize = Number(body.windowSize);
  const pickCount = Number(body.pickCount);
  const betAmount = Number(body.betAmount);
  if (!sessionId) return "缺少开奖登录会话";
  if (platform === "xingyi" && !xySessionId) return "缺少星亿娱乐登录会话";
  if (![60, 127, 128].includes(lotteryId)) return "彩种无效";
  if (!(position >= 1 && position <= 5)) return "投注位置无效";
  if (!(windowSize >= 1 && windowSize <= 100)) return "窗口无效";
  if (!(pickCount >= 1 && pickCount <= 10)) return "选号个数无效";
  if (!(betAmount > 0)) return "金额无效";

  const getSession = store().getSession;
  const aoshiSession = getSession?.(sessionId);
  const member = findMemberByAoshi(aoshiSession?.login_id ?? "") ?? findMemberById(String(body.memberId ?? ""));
  if (!member) return "当前账号不是会员，无法自动投注";
  if (!member.xyLoginId.trim()) return "未绑定星亿账号，无法自动投注";
  if (platform === "xingyi") {
    const xySession = getSession?.(xySessionId ?? "");
    const xyLogin = (xySession?.login_id ?? "").trim().toLowerCase();
    if (!xyLogin || xyLogin !== member.xyLoginId.trim().toLowerCase()) {
      return "星亿账号必须与该会员绑定的账号一致";
    }
  }

  return {
    memberId: member.id,
    platform,
    sessionId,
    xySessionId,
    lotteryId,
    position,
    windowSize,
    pickCount,
    excludeLast: Boolean(body.excludeLast),
    betAmount,
    martingaleOn: Boolean(body.martingaleOn),
    martingaleFactor: Number(body.martingaleFactor) || 2,
    martingaleReset: Number(body.martingaleReset) || 3,
  };
}

function persistJobs() {
  const jobs = [...store().jobs.values()].map((job) => ({
    enabled: job.enabled,
    memberId: job.memberId,
    platform: job.platform,
    sessionId: job.sessionId,
    xySessionId: job.xySessionId,
    lotteryId: job.lotteryId,
    position: job.position,
    windowSize: job.windowSize,
    pickCount: job.pickCount,
    excludeLast: job.excludeLast,
    betAmount: job.betAmount,
    martingaleOn: job.martingaleOn,
    martingaleFactor: job.martingaleFactor,
    martingaleReset: job.martingaleReset,
    lastBetIssue: job.lastBetIssue,
  }));
  savePersistedJobs(jobs);
}

function startJob(config: AutoBetConfig) {
  const s = store();
  const prev = s.jobs.get(config.memberId);
  const lotteryChanged = prev && prev.lotteryId !== config.lotteryId;
  s.jobs.set(config.memberId, {
    ...config,
    enabled: true,
    lastBetIssue: lotteryChanged || !prev?.enabled ? null : prev.lastBetIssue,
    scheduledIssue: prev && !lotteryChanged ? prev.scheduledIssue : null,
    scheduledAt: prev && !lotteryChanged ? prev.scheduledAt : null,
    liveIssue: prev?.liveIssue ?? null,
    closeAt: prev?.closeAt ?? null,
    lastError: "",
    lastPicks: prev?.lastPicks ?? [],
    placing: prev?.placing ?? false,
  });
  persistJobs();
  ensureTimer();
}

function stopJob(memberId?: string) {
  const s = store();
  if (memberId) {
    const job = s.jobs.get(memberId);
    if (job) {
      job.enabled = false;
      job.scheduledAt = null;
      job.scheduledIssue = null;
      job.placing = false;
    }
  } else {
    for (const job of s.jobs.values()) {
      job.enabled = false;
      job.scheduledAt = null;
      job.scheduledIssue = null;
      job.placing = false;
    }
  }
  persistJobs();
}

export function stopJobForMember(memberId: string) {
  const s = store();
  s.jobs.delete(memberId);
  persistJobs();
}

async function handleJobAuthFailure(job: Job, status: number, error: string) {
  job.lastError = error;
  if (!isLoginExpiredError(status, error)) return;
  await alertMemberLoginExpired(job.memberId, job.platform, error);
  stopJob(job.memberId);
}

async function tick() {
  const s = store();
  for (const job of [...s.jobs.values()]) {
    if (job.enabled) await tickJob(job);
  }
}

async function tickJob(job: Job) {
  const s = store();
  const call = s.call;
  if (!job.enabled || !call || job.placing) return;

  try {
    const betSession = job.platform === "xingyi" ? job.xySessionId : job.sessionId;
    if (!betSession) {
      job.lastError = "缺少投注会话";
      return;
    }

    let liveIssue: string | null = null;
    let closeAt: number | null = null;
    if (job.platform === "xingyi") {
      const issueResp = await call("xyissue", { sessionId: betSession, lotteryId: job.lotteryId });
      liveIssue = typeof issueResp.data.issue === "string" ? issueResp.data.issue : null;
      closeAt = typeof issueResp.data.closeAt === "number" ? issueResp.data.closeAt : null;
      if (!liveIssue) {
        const err = String(issueResp.data.error ?? "未能读取当前期号");
        await handleJobAuthFailure(job, issueResp.status, err);
        return;
      }
    }

    const drawsResp = await call("draws", { sessionId: job.sessionId, issueCount: 100, lotteryId: job.lotteryId });
    const draws = Array.isArray(drawsResp.data.draws) ? (drawsResp.data.draws as Draw[]) : [];
    if (draws.length === 0) {
      const err = String(drawsResp.data.error ?? "未获取到开奖数据");
      await handleJobAuthFailure(job, drawsResp.status, err);
      return;
    }

    await call("betsettle", {
      sessionId: betSession,
      draws: draws.map((d) => ({ issue: d.issue, numbers: d.numbers })),
    });

    const newest = [...draws].sort((a, b) => (issueEarlier(a.issue, b.issue) ? 1 : -1))[0];
    if (job.platform !== "xingyi") {
      liveIssue = nextIssue(newest?.issue ?? "");
      closeAt = null;
    }
    job.liveIssue = liveIssue;
    job.closeAt = closeAt;
    if (!liveIssue) return;
    if (sameIssue(liveIssue, job.lastBetIssue)) return;

    const oldestFirst = [...draws].sort((a, b) => (issueEarlier(a.issue, b.issue) ? -1 : 1));
    if (oldestFirst.length < job.windowSize) {
      job.lastError = "开奖数据不足，暂不投注";
      return;
    }
    const picks = computePicksFromHistory(
      oldestFirst.slice(-job.windowSize),
      job.pickCount,
      job.excludeLast,
      job.position,
    );
    job.lastPicks = picks;
    if (picks.length === 0) return;

    const remain = closeAt && closeAt > Date.now() ? closeAt - Date.now() : Number.POSITIVE_INFINITY;
    if (!sameIssue(job.scheduledIssue, liveIssue) || job.scheduledAt == null) {
      const delay = randomBetDelayMs(job.lotteryId, newest, closeAt);
      job.scheduledIssue = liveIssue;
      job.scheduledAt = Date.now() + delay;
    }
    if (remain > 4000 && job.scheduledAt != null && Date.now() < job.scheduledAt) return;

    const listResp = await call("betlist", { sessionId: betSession, lotteryId: job.lotteryId });
    const list = Array.isArray(listResp.data.bets) ? (listResp.data.bets as Bet[]) : [];
    const olderPending = list.some(
      (bet) => bet.status === "pending" && !sameIssue(bet.issue, liveIssue) && issueEarlier(bet.issue, liveIssue ?? ""),
    );
    if (olderPending && remain >= 2500) return;

    let amount = job.betAmount;
    if (job.martingaleOn) {
      const results = list
        .filter((bet) => bet.status === "won" || bet.status === "lost")
        .sort((a, b) => {
          if (issueEarlier(a.issue, b.issue)) return -1;
          if (issueEarlier(b.issue, a.issue)) return 1;
          return String(a.created_at ?? "").localeCompare(String(b.created_at ?? ""));
        })
        .map((bet) => bet.status as "won" | "lost");
      amount = stakeWithMultiplier(job.betAmount, nextMartingaleState(results, true, job.martingaleFactor, job.martingaleReset).multiplier);
    }

    job.placing = true;
    try {
      const action = job.platform === "xingyi" ? "xybet" : "bet";
      const betResp = await call(action, {
        sessionId: betSession,
        lotteryId: job.lotteryId,
        issue: liveIssue,
        picks,
        betAmount: amount,
        position: job.position,
      });
      if (betResp.data.success) {
        const actual = typeof betResp.data.issue === "string" && betResp.data.issue ? String(betResp.data.issue) : liveIssue;
        job.lastBetIssue = actual;
        job.scheduledAt = null;
        job.scheduledIssue = null;
        job.lastError = "";
        persistJobs();
      } else {
        job.lastError = String(betResp.data.error ?? `投注失败（HTTP ${betResp.status}）`);
        await handleJobAuthFailure(job, betResp.status, job.lastError);
      }
    } finally {
      job.placing = false;
    }
  } catch (err) {
    job.placing = false;
    job.lastError = err instanceof Error ? err.message : "自动投注异常";
    await handleJobAuthFailure(job, 0, job.lastError);
  }
}

function readMemberId(body: Record<string, unknown>): string {
  return typeof body.memberId === "string" ? body.memberId : "";
}

function jobForRequest(body: Record<string, unknown>): Job | null {
  const memberId = readMemberId(body);
  if (memberId) return store().jobs.get(memberId) ?? null;
  const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
  if (!sessionId) return null;
  return [...store().jobs.values()].find((job) => job.sessionId === sessionId || job.xySessionId === sessionId) ?? null;
}

export async function handleAutoBetHttp(action: string, req: Request): Promise<Response | null> {
  if (!action.startsWith("autobet-")) return null;
  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  if (action === "autobet-status") {
    return json(jobSnapshot(jobForRequest(body)));
  }
  if (action === "autobet-stop") {
    const memberId = readMemberId(body) || jobForRequest(body)?.memberId;
    stopJob(memberId);
    return json({ success: true, ...jobSnapshot(memberId ? store().jobs.get(memberId) ?? null : null) });
  }
  if (action === "autobet-start") {
    const parsed = parseConfig(body);
    if (typeof parsed === "string") return json({ error: parsed }, 400);
    startJob(parsed);
    return json({ success: true, ...jobSnapshot(store().jobs.get(parsed.memberId) ?? null) });
  }
  return json({ error: "Unknown autobet action" }, 400);
}
