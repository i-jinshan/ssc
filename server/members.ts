import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Member = {
  id: string;
  aoshiLoginId: string;
  xyLoginId: string;
  createdAt: string;
  telegramChatId?: string;
  telegramUsername?: string;
  telegramBindToken?: string;
  telegramBindCode?: string;
  telegramBindExpiresAt?: number;
  telegramBoundAt?: string;
  telegramAlertAt?: number;
};

const membersPath = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "members.json");

let members: Member[] = [];
let loaded = false;

function norm(value: string): string {
  return String(value ?? "").trim();
}

function key(value: string): string {
  return norm(value).toLowerCase();
}

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = JSON.parse(readFileSync(membersPath, "utf8")) as unknown;
    if (Array.isArray(parsed)) {
      members = parsed.filter((item) => item && typeof item === "object" && typeof (item as Member).id === "string") as Member[];
    }
  } catch {
    members = [];
  }
}

function flush() {
  ensureLoaded();
  mkdirSync(dirname(membersPath), { recursive: true });
  const tmp = `${membersPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(members, null, 2));
  renameSync(tmp, membersPath);
}

export function listMembers(): Member[] {
  ensureLoaded();
  return [...members].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function findMemberByAoshi(loginId: string): Member | null {
  ensureLoaded();
  const needle = key(loginId);
  if (!needle) return null;
  return members.find((item) => key(item.aoshiLoginId) === needle) ?? null;
}

export function findMemberByXy(loginId: string): Member | null {
  ensureLoaded();
  const needle = key(loginId);
  if (!needle) return null;
  return members.find((item) => key(item.xyLoginId) === needle) ?? null;
}

export function findMemberById(id: string): Member | null {
  ensureLoaded();
  return members.find((item) => item.id === id) ?? null;
}

export function findMemberByTelegramChatId(chatId: string): Member | null {
  ensureLoaded();
  const needle = String(chatId ?? "").trim();
  if (!needle) return null;
  return members.find((item) => item.telegramChatId === needle) ?? null;
}

export function addMember(aoshiLoginId: string, xyLoginId: string): Member | string {
  const aoshi = norm(aoshiLoginId);
  const xy = norm(xyLoginId);
  if (!aoshi) return "请填写傲世账号";
  if (findMemberByAoshi(aoshi)) return "该傲世账号已绑定会员";
  if (xy && findMemberByXy(xy)) return "该星亿账号已绑定会员";
  const row: Member = {
    id: crypto.randomUUID(),
    aoshiLoginId: aoshi,
    xyLoginId: xy,
    createdAt: new Date().toISOString(),
  };
  ensureLoaded();
  members.push(row);
  flush();
  return row;
}

export function updateMember(id: string, aoshiLoginId: string, xyLoginId: string): Member | string {
  ensureLoaded();
  const index = members.findIndex((item) => item.id === id);
  if (index < 0) return "会员不存在";
  const aoshi = norm(aoshiLoginId);
  const xy = norm(xyLoginId);
  if (!aoshi) return "请填写傲世账号";
  const otherAoshi = findMemberByAoshi(aoshi);
  if (otherAoshi && otherAoshi.id !== id) return "该傲世账号已绑定会员";
  if (xy) {
    const otherXy = findMemberByXy(xy);
    if (otherXy && otherXy.id !== id) return "该星亿账号已绑定会员";
  }
  members[index] = {
    ...members[index],
    aoshiLoginId: aoshi,
    xyLoginId: xy,
  };
  flush();
  return members[index];
}

export function removeMember(id: string): boolean {
  ensureLoaded();
  const next = members.filter((item) => item.id !== id);
  if (next.length === members.length) return false;
  members = next;
  flush();
  return true;
}

export function startTelegramBind(memberId: string, rawUsername: string): string | { username: string; bindToken: string; expiresAt: number } {
  ensureLoaded();
  const index = members.findIndex((item) => item.id === memberId);
  if (index < 0) return "会员不存在";
  const username = norm(rawUsername).replace(/^@/, "").toLowerCase();
  if (!/^[a-zA-Z][a-zA-Z0-9_]{4,31}$/.test(username)) return "请填写正确的 Telegram 用户名（不要填手机号）";
  const bindToken = `b${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const expiresAt = Date.now() + 30 * 60 * 1000;
  members[index] = {
    ...members[index],
    telegramUsername: username,
    telegramBindToken: bindToken,
    telegramBindExpiresAt: expiresAt,
    telegramBindCode: undefined,
  };
  flush();
  return { username, bindToken, expiresAt };
}

export function completeTelegramBind(chatId: string, bindToken?: string, fromUsername?: string): Member | null {
  ensureLoaded();
  const now = Date.now();
  const token = String(bindToken ?? "").trim();
  const user = String(fromUsername ?? "").replace(/^@/, "").toLowerCase();
  let index = -1;
  if (token) {
    index = members.findIndex(
      (item) => item.telegramBindToken === token && (item.telegramBindExpiresAt ?? 0) > now,
    );
  }
  if (index < 0 && user) {
    index = members.findIndex(
      (item) =>
        (item.telegramBindExpiresAt ?? 0) > now &&
        key(item.telegramUsername ?? "") === user,
    );
  }
  if (index < 0) return null;
  members[index] = {
    ...members[index],
    telegramChatId: String(chatId),
    telegramUsername: user || members[index].telegramUsername,
    telegramBoundAt: new Date().toISOString(),
    telegramBindToken: undefined,
    telegramBindCode: undefined,
    telegramBindExpiresAt: undefined,
  };
  flush();
  return members[index];
}

export function unbindTelegram(memberId: string): boolean {
  ensureLoaded();
  const index = members.findIndex((item) => item.id === memberId);
  if (index < 0) return false;
  members[index] = {
    ...members[index],
    telegramChatId: undefined,
    telegramUsername: undefined,
    telegramBoundAt: undefined,
    telegramBindToken: undefined,
    telegramBindCode: undefined,
    telegramBindExpiresAt: undefined,
    telegramAlertAt: undefined,
  };
  flush();
  return true;
}

export function setTelegramAlertAt(memberId: string, at: number) {
  ensureLoaded();
  const index = members.findIndex((item) => item.id === memberId);
  if (index < 0) return;
  members[index] = { ...members[index], telegramAlertAt: at };
  flush();
}

export function telegramPublic(member: Member) {
  const pending = (member.telegramBindExpiresAt ?? 0) > Date.now();
  return {
    bound: Boolean(member.telegramChatId),
    boundAt: member.telegramBoundAt ?? null,
    username: member.telegramUsername ?? null,
    pending: pending && !member.telegramChatId,
    expiresAt: pending ? member.telegramBindExpiresAt ?? null : null,
  };
}
