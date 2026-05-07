import { promises as fs } from "node:fs";
import path from "node:path";
import { bus } from "./events.js";

const LOG_FILE = process.env.LOG_FILE || "./data/bridge.log";

export async function log(event: Record<string, unknown>) {
  const entry = { t: new Date().toISOString(), ...event };
  const line = JSON.stringify(entry) + "\n";
  process.stdout.write(line);
  bus.emit({ kind: "log", data: entry });
  try {
    await fs.mkdir(path.dirname(LOG_FILE), { recursive: true });
    await fs.appendFile(LOG_FILE, line);
  } catch {
    // ignore disk errors
  }
}
