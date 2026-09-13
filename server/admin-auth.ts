import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_USERNAME = "admin";
const DEFAULT_PASSWORD = "111111";
const adminPath = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "admin.json");

type AdminFile = {
  username: string;
  password: string;
};

let creds: AdminFile = { username: DEFAULT_USERNAME, password: DEFAULT_PASSWORD };
let loaded = false;

function norm(value: string): string {
  return String(value ?? "").trim();
}

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  try {
    const parsed = JSON.parse(readFileSync(adminPath, "utf8")) as Partial<AdminFile>;
    const username = norm(String(parsed.username ?? ""));
    const password = String(parsed.password ?? "");
    if (username && password) {
      creds = { username, password };
      return;
    }
  } catch {
    // use defaults
  }
  creds = { username: DEFAULT_USERNAME, password: DEFAULT_PASSWORD };
}

function flush() {
  ensureLoaded();
  mkdirSync(dirname(adminPath), { recursive: true });
  const tmp = `${adminPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(creds, null, 2));
  renameSync(tmp, adminPath);
}

export function getAdminUsername(): string {
  ensureLoaded();
  return creds.username;
}

export function verifyAdminLogin(username: string, password: string): boolean {
  ensureLoaded();
  return norm(username).toLowerCase() === creds.username.toLowerCase() && password === creds.password;
}

export function updateAdminAccount(currentPassword: string, nextUsername: string, nextPassword: string): string | { username: string } {
  ensureLoaded();
  if (currentPassword !== creds.password) return "当前密码不正确";
  const username = norm(nextUsername) || creds.username;
  const password = nextPassword === "" ? creds.password : nextPassword;
  if (!username) return "新账号不能为空";
  if (password.length < 6) return "新密码至少 6 位";
  creds = { username, password };
  flush();
  return { username: creds.username };
}
