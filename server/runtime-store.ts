import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const runtimePath = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "runtime.json");

export type PersistedSession = {
  id: string;
  cookies: string;
  form_token: string | null;
  captcha_de_text: string | null;
  captcha_code?: string;
  login_token?: string;
  authenticated: boolean;
  login_id?: string;
};

export type PersistedJob = {
  enabled: boolean;
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
  lastBetIssue: string | null;
};

type RuntimeFile = {
  sessions: PersistedSession[];
  jobs: PersistedJob[];
};

let cache: RuntimeFile = { sessions: [], jobs: [] };
let loaded = false;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = JSON.parse(readFileSync(runtimePath, "utf8")) as RuntimeFile & { job?: PersistedJob | null };
    const jobs = Array.isArray(parsed.jobs) ? parsed.jobs : [];
    if (parsed.job && parsed.job.memberId) jobs.push(parsed.job);
    cache = {
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      jobs,
    };
  } catch {
    cache = { sessions: [], jobs: [] };
  }
}

function flush() {
  ensureLoaded();
  mkdirSync(dirname(runtimePath), { recursive: true });
  const tmp = `${runtimePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(cache, null, 2));
  renameSync(tmp, runtimePath);
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      flush();
    } catch {
      // ignore
    }
  }, 400);
}

export function loadPersistedSessions(): PersistedSession[] {
  ensureLoaded();
  return cache.sessions;
}

export function savePersistedSessions(sessions: PersistedSession[]) {
  ensureLoaded();
  cache.sessions = sessions;
  scheduleSave();
}

export function loadPersistedJobs(): PersistedJob[] {
  ensureLoaded();
  return cache.jobs.filter((item) => item?.memberId);
}

export function savePersistedJobs(jobs: PersistedJob[]) {
  ensureLoaded();
  cache.jobs = jobs;
  scheduleSave();
}
