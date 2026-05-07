import { promises as fs } from "node:fs";
import path from "node:path";

type SessionMap = Record<string, { sessionId: string; updatedAt: number }>;

const SESSIONS_FILE = process.env.SESSIONS_FILE || "./data/sessions.json";

let cache: SessionMap | null = null;

async function ensureDir() {
  await fs.mkdir(path.dirname(SESSIONS_FILE), { recursive: true });
}

async function load(): Promise<SessionMap> {
  if (cache) return cache;
  await ensureDir();
  try {
    const raw = await fs.readFile(SESSIONS_FILE, "utf8");
    cache = JSON.parse(raw) as SessionMap;
  } catch {
    cache = {};
  }
  return cache!;
}

async function save(map: SessionMap) {
  cache = map;
  await ensureDir();
  await fs.writeFile(SESSIONS_FILE, JSON.stringify(map, null, 2));
}

export function threadKey(channel: string, threadTs: string) {
  return `${channel}:${threadTs}`;
}

export async function getSession(key: string): Promise<string | null> {
  const map = await load();
  return map[key]?.sessionId ?? null;
}

export async function setSession(key: string, sessionId: string) {
  const map = await load();
  map[key] = { sessionId, updatedAt: Date.now() };
  await save(map);
}
