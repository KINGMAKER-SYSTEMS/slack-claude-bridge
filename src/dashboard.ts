import { promises as fs } from "node:fs";
import path from "node:path";

const CONTEXTS_DIR = process.env.CONTEXTS_DIR || "./data/contexts";
const LOG_FILE = process.env.LOG_FILE || "./data/bridge.log";

export async function getDashboardData() {
  const contexts: Array<{
    key: string;
    summary: string;
    msgsSinceSquash: number;
    summarizedThrough: string | null;
    updatedAt: number;
  }> = [];

  try {
    const files = await fs.readdir(CONTEXTS_DIR);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(CONTEXTS_DIR, f), "utf8");
        const data = JSON.parse(raw);
        contexts.push({
          key: f.replace(/\.json$/, ""),
          summary: data.summary || "",
          msgsSinceSquash: data.msgsSinceSquash || 0,
          summarizedThrough: data.summarizedThrough || null,
          updatedAt: data.updatedAt || 0,
        });
      } catch {}
    }
  } catch {}

  contexts.sort((a, b) => b.updatedAt - a.updatedAt);

  let recentLogs: any[] = [];
  try {
    const raw = await fs.readFile(LOG_FILE, "utf8");
    const lines = raw.trim().split("\n").slice(-200);
    recentLogs = lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();
  } catch {}

  const stats = {
    totalContexts: contexts.length,
    totalSpawns: recentLogs.filter((l) => l.kind === "spawn").length,
    totalReplies: recentLogs.filter((l) => l.kind === "replied").length,
    totalSquashes: recentLogs.filter((l) => l.kind === "squashed").length,
    totalErrors: recentLogs.filter((l) => l.kind === "error").length,
  };

  return { contexts, recentLogs, stats };
}

export function renderDashboardHtml(data: Awaited<ReturnType<typeof getDashboardData>>) {
  const { contexts, recentLogs, stats } = data;

  const contextRows = contexts
    .map((c) => {
      const time = new Date(c.updatedAt).toISOString().replace("T", " ").slice(0, 19);
      const summaryText = c.summary
        ? `<details><summary>${c.summary.length} chars</summary><pre>${escapeHtml(c.summary)}</pre></details>`
        : "<em>none</em>";
      return `<tr>
        <td><code>${escapeHtml(c.key)}</code></td>
        <td>${time}</td>
        <td>${c.msgsSinceSquash} / 10</td>
        <td>${summaryText}</td>
      </tr>`;
    })
    .join("");

  const logRows = recentLogs
    .slice(0, 100)
    .map((l) => {
      const time = l.t ? l.t.replace("T", " ").slice(11, 19) : "";
      const kind = l.kind || "";
      const color = kind === "error" || kind === "squash_failed"
        ? "#ff6666"
        : kind === "squashed"
          ? "#66ccff"
          : kind === "replied"
            ? "#88dd88"
            : "#aaa";
      const rest = Object.fromEntries(
        Object.entries(l).filter(([k]) => k !== "t" && k !== "kind"),
      );
      return `<tr>
        <td>${time}</td>
        <td style="color:${color}"><strong>${escapeHtml(kind)}</strong></td>
        <td><code>${escapeHtml(JSON.stringify(rest))}</code></td>
      </tr>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>smaths-bot dashboard</title>
<meta http-equiv="refresh" content="10">
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #1a1a1a; color: #eee; padding: 24px; max-width: 1200px; margin: 0 auto; }
  h1 { margin: 0 0 8px; font-size: 22px; }
  h2 { margin: 32px 0 12px; font-size: 16px; color: #aaa; text-transform: uppercase; letter-spacing: 1px; }
  .stats { display: flex; gap: 16px; margin: 16px 0 24px; }
  .stat { background: #2a2a2a; padding: 12px 16px; border-radius: 6px; min-width: 100px; }
  .stat-label { font-size: 11px; color: #888; text-transform: uppercase; letter-spacing: 1px; }
  .stat-value { font-size: 24px; font-weight: 600; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px; background: #2a2a2a; color: #aaa; font-weight: 600; border-bottom: 1px solid #333; }
  td { padding: 8px; border-bottom: 1px solid #2a2a2a; vertical-align: top; }
  code { background: #2a2a2a; padding: 2px 5px; border-radius: 3px; font-size: 12px; }
  pre { background: #2a2a2a; padding: 8px; border-radius: 4px; white-space: pre-wrap; font-size: 12px; max-width: 600px; }
  details summary { cursor: pointer; color: #888; }
  .meta { color: #666; font-size: 12px; margin-top: 32px; }
  em { color: #666; }
</style>
</head>
<body>
  <h1>smaths-bot dashboard</h1>
  <div class="stats">
    <div class="stat"><div class="stat-label">Active contexts</div><div class="stat-value">${stats.totalContexts}</div></div>
    <div class="stat"><div class="stat-label">Spawns (last 200)</div><div class="stat-value">${stats.totalSpawns}</div></div>
    <div class="stat"><div class="stat-label">Replies</div><div class="stat-value">${stats.totalReplies}</div></div>
    <div class="stat"><div class="stat-label">Squashes</div><div class="stat-value">${stats.totalSquashes}</div></div>
    <div class="stat"><div class="stat-label">Errors</div><div class="stat-value" style="color:${stats.totalErrors > 0 ? "#ff6666" : "#eee"}">${stats.totalErrors}</div></div>
  </div>

  <h2>Active contexts (most recent first)</h2>
  <table>
    <thead><tr><th>Thread / channel</th><th>Last activity (UTC)</th><th>Msgs since squash</th><th>Running summary</th></tr></thead>
    <tbody>${contextRows || '<tr><td colspan="4"><em>none yet</em></td></tr>'}</tbody>
  </table>

  <h2>Recent events (last 100)</h2>
  <table>
    <thead><tr><th>Time</th><th>Event</th><th>Details</th></tr></thead>
    <tbody>${logRows || '<tr><td colspan="3"><em>no events yet</em></td></tr>'}</tbody>
  </table>

  <p class="meta">Auto-refreshes every 10s. JSON: <a href="/dashboard.json" style="color:#88dd88">/dashboard.json</a></p>
</body>
</html>`;
}

function escapeHtml(s: string) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
