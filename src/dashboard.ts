import { promises as fs } from "node:fs";
import path from "node:path";

const CONTEXTS_DIR = process.env.CONTEXTS_DIR || "./data/contexts";
const LOG_FILE = process.env.LOG_FILE || "./data/bridge.log";

export type ContextSummary = {
  key: string;
  channel: string;
  threadTs: string;
  summary: string;
  msgsSinceSquash: number;
  summarizedThrough: string | null;
  updatedAt: number;
};

export async function getContexts(): Promise<ContextSummary[]> {
  const contexts: ContextSummary[] = [];
  try {
    const files = await fs.readdir(CONTEXTS_DIR);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(CONTEXTS_DIR, f), "utf8");
        const data = JSON.parse(raw);
        const key = f.replace(/\.json$/, "");
        const [channel = "", threadTs = ""] = key.split(":");
        contexts.push({
          key,
          channel,
          threadTs,
          summary: data.summary || "",
          msgsSinceSquash: data.msgsSinceSquash || 0,
          summarizedThrough: data.summarizedThrough || null,
          updatedAt: data.updatedAt || 0,
        });
      } catch {}
    }
  } catch {}
  contexts.sort((a, b) => b.updatedAt - a.updatedAt);
  return contexts;
}

export async function getRecentLogs(limit = 200): Promise<any[]> {
  try {
    const raw = await fs.readFile(LOG_FILE, "utf8");
    const lines = raw.trim().split("\n").slice(-limit);
    return lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();
  } catch {
    return [];
  }
}

export async function getDashboardData() {
  const [contexts, recentLogs] = await Promise.all([
    getContexts(),
    getRecentLogs(200),
  ]);
  const stats = {
    totalContexts: contexts.length,
    totalSpawns: recentLogs.filter((l) => l.kind === "spawn").length,
    totalReplies: recentLogs.filter((l) => l.kind === "replied").length,
    totalSquashes: recentLogs.filter((l) => l.kind === "squashed").length,
    totalErrors: recentLogs.filter(
      (l) => l.kind === "error" || l.kind === "squash_failed",
    ).length,
    portalSends: recentLogs.filter((l) => l.kind === "portal_send").length,
    portalReplies: recentLogs.filter((l) => l.kind === "portal_reply").length,
  };
  return { contexts, recentLogs, stats };
}

export function renderAppHtml(token: string): string {
  const manifestHref = token
    ? `/manifest.webmanifest?token=${encodeURIComponent(token)}`
    : "/manifest.webmanifest";
  return APP_HTML.replace("__TOKEN__", JSON.stringify(token)).replace(
    "__MANIFEST_HREF__",
    manifestHref,
  );
}

const APP_HTML = String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>smaths-bot HQ</title>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#a78bfa">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="SmathsBot">
<link rel="manifest" href="__MANIFEST_HREF__">
<link rel="apple-touch-icon" href="/icons/icon-180.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg-0: #0a0a0c;
    --bg-1: #111114;
    --bg-2: #16161b;
    --bg-3: #1d1d24;
    --bg-hover: #22222b;
    --line: #25252e;
    --line-soft: #1c1c24;
    --text: #f0f0f3;
    --text-muted: #9696a3;
    --text-dim: #5d5d68;
    --accent: #a78bfa;
    --accent-2: #60a5fa;
    --good: #4ade80;
    --warn: #fbbf24;
    --bad: #f87171;
    --user: #2563eb;
    --tool: #f59e0b;
    --gradient: linear-gradient(135deg, #a78bfa 0%, #60a5fa 100%);
    --gradient-soft: linear-gradient(135deg, rgba(167,139,250,0.15), rgba(96,165,250,0.08));
    --shadow-lg: 0 20px 50px rgba(0,0,0,0.4);
    --radius-sm: 6px;
    --radius: 10px;
    --radius-lg: 14px;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: var(--bg-0);
    color: var(--text);
    font-family: "Inter", -apple-system, system-ui, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    height: 100vh;
    overflow: hidden;
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
  }
  body {
    background:
      radial-gradient(ellipse at top left, rgba(167,139,250,0.08), transparent 50%),
      radial-gradient(ellipse at bottom right, rgba(96,165,250,0.06), transparent 50%),
      var(--bg-0);
  }
  code, pre, .mono { font-family: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, monospace; }
  button, input, textarea { font-family: inherit; color: inherit; }
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--line); border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--line); opacity: 0.8; }

  /* Layout */
  #app {
    display: grid;
    grid-template-columns: 280px 1fr 320px;
    grid-template-rows: 56px 1fr;
    height: 100vh;
    width: 100vw;
  }
  header.topbar {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 20px;
    border-bottom: 1px solid var(--line-soft);
    background: rgba(13,13,16,0.7);
    backdrop-filter: blur(12px);
    z-index: 5;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 14px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }
  .brand .dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--gradient);
    box-shadow: 0 0 12px rgba(167,139,250,0.6);
  }
  .brand .sub { color: var(--text-muted); font-weight: 400; font-size: 12px; }
  .topstats { display: flex; gap: 18px; align-items: center; }
  .ts-item { display: flex; align-items: baseline; gap: 6px; font-size: 12px; }
  .ts-item .num { font-weight: 600; font-size: 13px; }
  .ts-item .lbl { color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.06em; font-size: 10px; }
  .conn { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--text-dim); }
  .conn .pulse { width: 6px; height: 6px; border-radius: 50%; background: var(--bad); }
  .conn.live .pulse { background: var(--good); animation: pulse 2s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }

  /* Sidebar */
  aside.sidebar {
    grid-row: 2;
    border-right: 1px solid var(--line-soft);
    background: var(--bg-1);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .side-section {
    padding: 14px 14px 8px;
    border-bottom: 1px solid var(--line-soft);
  }
  .side-section:last-child { border-bottom: none; flex: 1; overflow-y: auto; }
  .side-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 4px 8px;
  }
  .side-head h3 {
    margin: 0;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-dim);
    font-weight: 600;
  }
  .side-head button.icon {
    background: none;
    border: none;
    color: var(--text-muted);
    cursor: pointer;
    padding: 4px 6px;
    border-radius: 4px;
    font-size: 14px;
    line-height: 1;
  }
  .side-head button.icon:hover { background: var(--bg-hover); color: var(--text); }
  .nav-list { display: flex; flex-direction: column; gap: 2px; }
  .nav-item {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    transition: background 0.12s;
    border: 1px solid transparent;
    text-align: left;
    background: none;
    color: inherit;
    width: 100%;
  }
  .nav-item:hover { background: var(--bg-2); }
  .nav-item.active {
    background: var(--bg-3);
    border-color: var(--line);
  }
  .nav-item .meta { flex: 1; min-width: 0; }
  .nav-item .title {
    font-size: 13px;
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .nav-item .preview {
    color: var(--text-dim);
    font-size: 11px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-top: 2px;
  }
  .nav-item .badge {
    font-size: 10px;
    color: var(--text-dim);
    flex-shrink: 0;
  }
  .nav-item .ico {
    width: 20px; height: 20px;
    border-radius: 5px;
    background: var(--bg-3);
    display: flex; align-items: center; justify-content: center;
    font-size: 10px;
    flex-shrink: 0;
    margin-top: 1px;
  }
  .nav-item.active .ico { background: var(--gradient-soft); }

  /* Main pane */
  main.main {
    grid-row: 2;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--bg-0);
  }
  .pane-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 24px;
    border-bottom: 1px solid var(--line-soft);
    min-height: 56px;
  }
  .pane-head .title-block { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .pane-head h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
    letter-spacing: -0.01em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pane-head .submeta { font-size: 11px; color: var(--text-dim); font-family: "JetBrains Mono", monospace; }
  .pane-actions { display: flex; gap: 8px; }
  .btn {
    background: var(--bg-2);
    border: 1px solid var(--line);
    color: var(--text);
    padding: 6px 12px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    font-size: 12px;
    font-weight: 500;
    transition: all 0.12s;
  }
  .btn:hover { background: var(--bg-3); border-color: var(--text-dim); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .btn.danger:hover { color: var(--bad); border-color: var(--bad); }
  .btn.primary {
    background: var(--gradient);
    border-color: transparent;
    color: #0a0a0c;
    font-weight: 600;
  }
  .btn.primary:hover { filter: brightness(1.1); }

  /* Chat */
  .chat-scroll {
    flex: 1;
    overflow-y: auto;
    padding: 20px 24px 24px;
  }
  .chat-stream {
    max-width: 760px;
    margin: 0 auto;
    display: flex;
    flex-direction: column;
    gap: 18px;
  }
  .msg {
    display: flex;
    gap: 12px;
    animation: msgin 0.25s ease-out;
  }
  @keyframes msgin { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  .msg .avatar {
    width: 28px; height: 28px;
    border-radius: 7px;
    flex-shrink: 0;
    display: flex; align-items: center; justify-content: center;
    font-size: 11px;
    font-weight: 700;
    margin-top: 2px;
  }
  .msg.user .avatar { background: var(--user); color: white; }
  .msg.assistant .avatar { background: var(--gradient); color: #0a0a0c; }
  .msg .body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .msg .who {
    font-size: 11px;
    color: var(--text-dim);
    font-weight: 500;
  }
  .msg .content {
    font-size: 14px;
    line-height: 1.6;
    word-wrap: break-word;
  }
  .msg.user .content {
    background: rgba(37,99,235,0.12);
    border: 1px solid rgba(37,99,235,0.25);
    padding: 10px 14px;
    border-radius: var(--radius);
    align-self: flex-start;
    max-width: 100%;
  }
  .msg .content p { margin: 0 0 8px; }
  .msg .content p:last-child { margin: 0; }
  .msg .content code {
    background: var(--bg-2);
    border: 1px solid var(--line-soft);
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 12px;
  }
  .msg .content pre {
    background: var(--bg-1);
    border: 1px solid var(--line-soft);
    padding: 12px 14px;
    border-radius: var(--radius-sm);
    overflow-x: auto;
    font-size: 12px;
    line-height: 1.55;
    margin: 8px 0;
  }
  .msg .content pre code { background: none; border: none; padding: 0; }
  .msg .content a { color: var(--accent-2); text-decoration: none; }
  .msg .content a:hover { text-decoration: underline; }
  .msg .content ul, .msg .content ol { margin: 6px 0; padding-left: 22px; }
  .msg .content blockquote {
    border-left: 2px solid var(--line);
    padding-left: 10px;
    color: var(--text-muted);
    margin: 8px 0;
  }
  .msg .content h1, .msg .content h2, .msg .content h3 { margin: 12px 0 6px; font-weight: 600; }

  .tool-stack { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }
  .tool-card {
    background: var(--bg-1);
    border: 1px solid var(--line-soft);
    border-radius: var(--radius-sm);
    overflow: hidden;
    font-size: 12px;
  }
  .tool-card .tc-head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    cursor: pointer;
    user-select: none;
  }
  .tool-card .tc-head:hover { background: var(--bg-2); }
  .tool-card .chev { color: var(--text-dim); font-size: 10px; transition: transform 0.15s; }
  .tool-card.open .chev { transform: rotate(90deg); }
  .tool-card .tc-icon {
    width: 18px; height: 18px;
    border-radius: 4px;
    background: rgba(245,158,11,0.15);
    color: var(--tool);
    display: flex; align-items: center; justify-content: center;
    font-size: 10px;
    flex-shrink: 0;
  }
  .tool-card.error .tc-icon { background: rgba(248,113,113,0.15); color: var(--bad); }
  .tool-card.running .tc-icon { background: rgba(167,139,250,0.15); color: var(--accent); animation: pulse 1.4s ease-in-out infinite; }
  .tool-card .tc-name { font-family: "JetBrains Mono", monospace; font-size: 11px; font-weight: 500; }
  .tool-card .tc-status { margin-left: auto; font-size: 10px; color: var(--text-dim); }
  .tool-card.error .tc-status { color: var(--bad); }
  .tool-card .tc-body {
    padding: 0 12px 10px 12px;
    border-top: 1px solid var(--line-soft);
    display: none;
  }
  .tool-card.open .tc-body { display: block; }
  .tool-card .tc-body pre {
    margin: 8px 0 0;
    background: var(--bg-0);
    border: 1px solid var(--line-soft);
    padding: 8px 10px;
    border-radius: 4px;
    font-size: 11px;
    overflow-x: auto;
    max-height: 260px;
  }

  .thinking {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    color: var(--text-muted);
    font-style: italic;
  }
  .thinking .dots { display: inline-flex; gap: 3px; }
  .thinking .dots span {
    width: 4px; height: 4px;
    border-radius: 50%;
    background: var(--accent);
    animation: bounce 1.2s ease-in-out infinite;
  }
  .thinking .dots span:nth-child(2) { animation-delay: 0.15s; }
  .thinking .dots span:nth-child(3) { animation-delay: 0.3s; }
  @keyframes bounce { 0%,80%,100% { opacity: 0.3; transform: translateY(0); } 40% { opacity: 1; transform: translateY(-3px); } }

  .empty-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
    gap: 12px;
    padding: 60px 20px;
    text-align: center;
  }
  .empty-state .es-icon {
    font-size: 32px;
    width: 56px; height: 56px;
    background: var(--gradient-soft);
    border: 1px solid var(--line);
    border-radius: 16px;
    display: flex; align-items: center; justify-content: center;
  }
  .empty-state h3 { margin: 0; font-size: 16px; color: var(--text); font-weight: 600; }
  .empty-state p { margin: 0; max-width: 360px; font-size: 13px; }

  /* Composer */
  .composer {
    border-top: 1px solid var(--line-soft);
    padding: 14px 24px 18px;
    background: var(--bg-1);
  }
  .composer-inner {
    max-width: 760px;
    margin: 0 auto;
  }
  .composer-shell {
    background: var(--bg-2);
    border: 1px solid var(--line);
    border-radius: var(--radius);
    padding: 10px 12px;
    transition: border-color 0.12s;
  }
  .composer-shell:focus-within { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(167,139,250,0.12); }
  .composer textarea {
    width: 100%;
    background: transparent;
    border: none;
    color: var(--text);
    font-size: 14px;
    line-height: 1.5;
    resize: none;
    outline: none;
    min-height: 24px;
    max-height: 200px;
  }
  .composer textarea::placeholder { color: var(--text-dim); }
  .composer-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 8px;
  }
  .composer-hint { color: var(--text-dim); font-size: 11px; }
  .composer-hint kbd {
    background: var(--bg-3);
    border: 1px solid var(--line);
    padding: 1px 6px;
    border-radius: 4px;
    font-size: 10px;
    font-family: "JetBrains Mono", monospace;
  }

  /* Right rail */
  aside.right {
    grid-row: 2;
    border-left: 1px solid var(--line-soft);
    background: var(--bg-1);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
  }
  .rail-section {
    padding: 14px 16px;
    border-bottom: 1px solid var(--line-soft);
  }
  .rail-section h4 {
    margin: 0 0 10px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-dim);
    font-weight: 600;
  }
  .stat-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
  }
  .stat-card {
    background: var(--bg-2);
    border: 1px solid var(--line-soft);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
  }
  .stat-card .label {
    font-size: 10px;
    color: var(--text-dim);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .stat-card .value {
    font-size: 18px;
    font-weight: 600;
    margin-top: 2px;
    letter-spacing: -0.01em;
  }
  .stat-card.error .value { color: var(--bad); }
  .stat-card.good .value { color: var(--good); }

  .activity-feed {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 480px;
    overflow-y: auto;
  }
  .activity-item {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 6px 8px;
    border-radius: 4px;
    font-size: 11px;
    border: 1px solid transparent;
    animation: msgin 0.25s ease-out;
  }
  .activity-item:hover { background: var(--bg-2); }
  .activity-item .dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    margin-top: 5px;
    flex-shrink: 0;
    background: var(--text-dim);
  }
  .activity-item.replied .dot, .activity-item.portal_reply .dot { background: var(--good); }
  .activity-item.error .dot, .activity-item.squash_failed .dot, .activity-item.portal_error .dot { background: var(--bad); }
  .activity-item.squashed .dot { background: var(--accent-2); }
  .activity-item.spawn .dot, .activity-item.portal_send .dot { background: var(--accent); }
  .activity-item .ai-meta { flex: 1; min-width: 0; }
  .activity-item .ai-kind {
    font-weight: 500;
    color: var(--text);
    text-transform: lowercase;
    font-family: "JetBrains Mono", monospace;
    font-size: 10px;
  }
  .activity-item .ai-detail {
    color: var(--text-dim);
    font-size: 10px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .activity-item time {
    color: var(--text-dim);
    font-size: 10px;
    font-family: "JetBrains Mono", monospace;
    flex-shrink: 0;
  }

  /* Thread detail view */
  .thread-detail { padding: 20px 24px; max-width: 760px; margin: 0 auto; width: 100%; flex: 1; overflow-y: auto; }
  .detail-card {
    background: var(--bg-1);
    border: 1px solid var(--line-soft);
    border-radius: var(--radius);
    padding: 16px 18px;
    margin-bottom: 14px;
  }
  .detail-card h4 {
    margin: 0 0 8px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-dim);
    font-weight: 600;
  }
  .summary-text {
    font-size: 13px;
    line-height: 1.6;
    color: var(--text);
    white-space: pre-wrap;
  }
  .summary-text.empty { color: var(--text-dim); font-style: italic; }
  .progress {
    height: 6px;
    background: var(--bg-3);
    border-radius: 3px;
    overflow: hidden;
    margin-top: 8px;
  }
  .progress .fill {
    height: 100%;
    background: var(--gradient);
    transition: width 0.3s ease;
  }
  .kv {
    display: grid;
    grid-template-columns: 100px 1fr;
    gap: 6px 14px;
    font-size: 12px;
  }
  .kv dt { color: var(--text-dim); }
  .kv dd { margin: 0; font-family: "JetBrains Mono", monospace; }

  /* Modal */
  .modal-bg {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.5);
    backdrop-filter: blur(4px);
    display: none;
    align-items: center; justify-content: center;
    z-index: 100;
  }
  .modal-bg.show { display: flex; }
  .modal {
    background: var(--bg-1);
    border: 1px solid var(--line);
    border-radius: var(--radius-lg);
    padding: 20px;
    width: 100%;
    max-width: 420px;
    box-shadow: var(--shadow-lg);
  }
  .modal h3 { margin: 0 0 6px; font-size: 15px; }
  .modal p { color: var(--text-muted); font-size: 13px; margin: 0 0 14px; }
  .modal input {
    width: 100%;
    background: var(--bg-2);
    border: 1px solid var(--line);
    border-radius: var(--radius-sm);
    padding: 10px 12px;
    color: var(--text);
    font-size: 13px;
    outline: none;
  }
  .modal input:focus { border-color: var(--accent); }
  .modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }

  /* Hamburger buttons (mobile only) */
  .hamburger {
    display: none;
    background: none;
    border: 1px solid var(--line);
    color: var(--text-muted);
    width: 36px; height: 36px;
    border-radius: var(--radius-sm);
    cursor: pointer;
    align-items: center;
    justify-content: center;
    padding: 0;
    flex-shrink: 0;
  }
  .hamburger:active { background: var(--bg-hover); }
  .hamburger svg { width: 18px; height: 18px; }
  .topbar-left { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .topbar-right { display: flex; align-items: center; gap: 12px; }
  .drawer-backdrop {
    display: none;
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,0.55);
    backdrop-filter: blur(2px);
    z-index: 8;
  }
  .drawer-backdrop.open { display: block; }

  /* Tablet — collapse right rail into drawer */
  @media (max-width: 1100px) {
    #app { grid-template-columns: 280px 1fr; }
    aside.right {
      position: fixed;
      top: 56px;
      right: 0;
      bottom: 0;
      width: min(360px, 88vw);
      z-index: 9;
      transform: translateX(100%);
      transition: transform 0.22s ease;
      box-shadow: var(--shadow-lg);
      border-left: 1px solid var(--line-soft);
    }
    aside.right.open { transform: translateX(0); }
    .hamburger.right-toggle { display: inline-flex; }
  }

  /* Phone — both sidebars become drawers */
  @media (max-width: 720px) {
    #app { grid-template-columns: 1fr; }
    .topstats .ts-item { display: none; }
    .topstats .ts-item:first-child,
    .topstats .conn { display: flex; }
    aside.sidebar {
      position: fixed;
      top: 56px;
      left: 0;
      bottom: 0;
      width: min(300px, 84vw);
      z-index: 9;
      transform: translateX(-100%);
      transition: transform 0.22s ease;
      box-shadow: var(--shadow-lg);
      border-right: 1px solid var(--line-soft);
    }
    aside.sidebar.open { transform: translateX(0); }
    .hamburger.left-toggle { display: inline-flex; }
    .pane-head { padding: 12px 16px; }
    .chat-scroll { padding: 16px 14px 18px; }
    .composer-inner { padding: 10px 12px 12px; }
    .composer-shell textarea {
      font-size: 16px;  /* prevent iOS zoom on focus */
    }
    .composer-actions { flex-wrap: wrap; gap: 8px; }
    .composer-hint { font-size: 10px; }
    .pane-head h2 { font-size: 14px; }
    .nav-item { padding: 12px 12px; }  /* larger tap target */
    .nav-item .title { font-size: 14px; }
  }

  /* Very small phones */
  @media (max-width: 380px) {
    .brand .sub { display: none; }
    .composer-hint { display: none; }
  }
</style>
</head>
<body>
<div id="app">
  <header class="topbar">
    <div class="topbar-left">
      <button class="hamburger left-toggle" id="left-toggle" aria-label="Open navigation">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><line x1="3" y1="6" x2="17" y2="6"/><line x1="3" y1="10" x2="17" y2="10"/><line x1="3" y1="14" x2="17" y2="14"/></svg>
      </button>
      <div class="brand">
        <span class="dot"></span>
        <span>smaths-bot</span>
        <span class="sub">/ HQ</span>
      </div>
    </div>
    <div class="topbar-right">
      <div class="topstats">
        <div class="ts-item"><span class="num" id="st-contexts">0</span><span class="lbl">threads</span></div>
        <div class="ts-item"><span class="num" id="st-replies">0</span><span class="lbl">replies</span></div>
        <div class="ts-item"><span class="num" id="st-portal">0</span><span class="lbl">portal</span></div>
        <div class="ts-item"><span class="num" id="st-errors">0</span><span class="lbl">errors</span></div>
        <div class="conn" id="conn"><span class="pulse"></span><span id="conn-text">connecting…</span></div>
      </div>
      <button class="hamburger right-toggle" id="right-toggle" aria-label="Open activity feed">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="10" cy="4" r="1.5"/><circle cx="10" cy="10" r="1.5"/><circle cx="10" cy="16" r="1.5"/></svg>
      </button>
    </div>
  </header>
  <div class="drawer-backdrop" id="drawer-backdrop"></div>

  <aside class="sidebar">
    <div class="side-section">
      <div class="side-head">
        <h3>Portal</h3>
        <button class="icon" id="new-convo" title="New conversation">+</button>
      </div>
      <div class="nav-list" id="convo-list"></div>
    </div>
    <div class="side-section">
      <div class="side-head"><h3>Slack threads</h3></div>
      <div class="nav-list" id="thread-list"></div>
    </div>
  </aside>

  <main class="main">
    <div class="pane-head" id="pane-head">
      <div class="title-block">
        <h2 id="pane-title">smaths-bot</h2>
        <div class="submeta" id="pane-sub"></div>
      </div>
      <div class="pane-actions" id="pane-actions"></div>
    </div>
    <div class="chat-scroll" id="chat-scroll">
      <div class="empty-state" id="empty">
        <div class="es-icon">✨</div>
        <h3>Talk to smaths-bot</h3>
        <p>Spin up a portal conversation, peek into a Slack thread, or just watch the live activity stream on the right.</p>
      </div>
    </div>
    <div class="composer" id="composer" style="display:none">
      <div class="composer-inner">
        <div class="composer-shell">
          <textarea id="input" placeholder="Tell smaths-bot what to do…" rows="1"></textarea>
        </div>
        <div class="composer-actions">
          <span class="composer-hint"><kbd>⌘</kbd> + <kbd>Enter</kbd> to send · agent always asks before posting to Slack</span>
          <button class="btn primary" id="send">Send</button>
        </div>
      </div>
    </div>
  </main>

  <aside class="right">
    <div class="rail-section">
      <h4>Today's stats</h4>
      <div class="stat-grid" id="stat-grid"></div>
    </div>
    <div class="rail-section" style="flex:1;">
      <h4>Live activity</h4>
      <div class="activity-feed" id="activity"></div>
    </div>
  </aside>
</div>

<div class="modal-bg" id="modal-bg">
  <div class="modal">
    <h3 id="modal-title">Rename conversation</h3>
    <p id="modal-desc">Pick a short label.</p>
    <input id="modal-input" type="text" placeholder="Title">
    <div class="modal-actions">
      <button class="btn" id="modal-cancel">Cancel</button>
      <button class="btn primary" id="modal-ok">Save</button>
    </div>
  </div>
</div>

<script>
const TOKEN = __TOKEN__;
const tokParam = TOKEN ? "?token=" + encodeURIComponent(TOKEN) : "";
const tokAmp = TOKEN ? "&token=" + encodeURIComponent(TOKEN) : "";

// PWA service worker — Chrome/Android only. iOS Safari ignores it for
// install but registering is harmless.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

const $ = (id) => document.getElementById(id);
const conv = $("convo-list");
const threadEl = $("thread-list");
const chat = $("chat-scroll");
const empty = $("empty");
const composer = $("composer");
const input = $("input");
const send = $("send");
const activityEl = $("activity");
const statGrid = $("stat-grid");
const paneTitle = $("pane-title");
const paneSub = $("pane-sub");
const paneActions = $("pane-actions");
const conn = $("conn");
const connText = $("conn-text");
const sidebarEl = document.querySelector("aside.sidebar");
const rightRailEl = document.querySelector("aside.right");
const drawerBackdrop = $("drawer-backdrop");
const leftToggleBtn = $("left-toggle");
const rightToggleBtn = $("right-toggle");

function closeDrawers() {
  sidebarEl?.classList.remove("open");
  rightRailEl?.classList.remove("open");
  drawerBackdrop?.classList.remove("open");
}
function openDrawer(which) {
  closeDrawers();
  if (which === "left") sidebarEl?.classList.add("open");
  if (which === "right") rightRailEl?.classList.add("open");
  drawerBackdrop?.classList.add("open");
}
leftToggleBtn?.addEventListener("click", () => {
  if (sidebarEl?.classList.contains("open")) closeDrawers();
  else openDrawer("left");
});
rightToggleBtn?.addEventListener("click", () => {
  if (rightRailEl?.classList.contains("open")) closeDrawers();
  else openDrawer("right");
});
drawerBackdrop?.addEventListener("click", closeDrawers);
// Close drawers when picking a conversation/thread on mobile
document.addEventListener("click", (e) => {
  const t = e.target;
  if (!(t instanceof Element)) return;
  if (t.closest(".nav-item") && window.matchMedia("(max-width: 720px)").matches) {
    closeDrawers();
  }
});

const state = {
  view: "empty", // 'empty' | 'portal' | 'thread'
  activeConvoId: null,
  activeThreadKey: null,
  portals: [],
  contexts: [],
  logs: [],
  stats: {},
  currentMessages: [],
  streamingText: "",
  streamingTools: [],
  streaming: false,
};

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Tiny markdown renderer (safe-ish: escape first, then format)
function renderMarkdown(src) {
  if (!src) return "";
  let s = escHtml(src);
  // fenced code
  s = s.replace(/\`\`\`([\s\S]*?)\`\`\`/g, (_, code) => "<pre><code>" + code.replace(/^\n/, "") + "</code></pre>");
  // inline code
  s = s.replace(/\`([^\`\n]+)\`/g, "<code>$1</code>");
  // bold/italic
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  // links
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // headings
  s = s.replace(/^### (.+)$/gm, "<h3>$1</h3>");
  s = s.replace(/^## (.+)$/gm, "<h2>$1</h2>");
  s = s.replace(/^# (.+)$/gm, "<h1>$1</h1>");
  // bullets
  s = s.replace(/(?:^|\n)- (.+)/g, (m, t) => "\n<ul><li>" + t + "</li></ul>");
  s = s.replace(/<\/ul>\s*<ul>/g, "");
  // blockquote
  s = s.replace(/^> (.+)$/gm, "<blockquote>$1</blockquote>");
  // paragraphs (split on blank line)
  const blocks = s.split(/\n{2,}/).map(b => {
    if (/^<(h\d|ul|ol|pre|blockquote)/.test(b.trim())) return b;
    return "<p>" + b.replace(/\n/g, "<br>") + "</p>";
  });
  return blocks.join("\n");
}

function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(typeof ts === "number" ? ts : Date.parse(ts));
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function fmtRel(ts) {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + "m";
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + "h";
  return Math.floor(diff / 86_400_000) + "d";
}

// ---- API ----
async function api(path, opts = {}) {
  const url = path + (path.includes("?") ? tokAmp : tokParam);
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function loadAll() {
  try {
    const [portals, dash] = await Promise.all([
      api("/portal/list"),
      api("/dashboard.json"),
    ]);
    state.portals = portals;
    state.contexts = dash.contexts || [];
    state.logs = dash.recentLogs || [];
    state.stats = dash.stats || {};
    renderSidebar();
    renderStats();
    renderActivity();
  } catch (e) {
    connText.textContent = "auth error";
    conn.classList.remove("live");
  }
}

function renderSidebar() {
  conv.innerHTML = state.portals.map(p => {
    const active = p.id === state.activeConvoId && state.view === "portal" ? "active" : "";
    return '<button class="nav-item ' + active + '" data-id="' + escHtml(p.id) + '">'
      + '<div class="ico">💬</div>'
      + '<div class="meta">'
        + '<div class="title">' + escHtml(p.title || "untitled") + '</div>'
        + '<div class="preview">' + (p.lastMessage ? escHtml(p.lastMessage) : '<em style="color:var(--text-dim)">no messages</em>') + '</div>'
      + '</div>'
      + '<div class="badge">' + (p.messageCount || 0) + '</div>'
    + '</button>';
  }).join("") || '<div style="color:var(--text-dim);font-size:11px;padding:6px 10px;">no conversations yet</div>';

  threadEl.innerHTML = state.contexts.slice(0, 30).map(c => {
    const active = c.key === state.activeThreadKey && state.view === "thread" ? "active" : "";
    const pct = Math.min(100, (c.msgsSinceSquash / 10) * 100);
    return '<button class="nav-item ' + active + '" data-key="' + escHtml(c.key) + '">'
      + '<div class="ico">#</div>'
      + '<div class="meta">'
        + '<div class="title mono" style="font-size:11px;">' + escHtml(c.channel) + '</div>'
        + '<div class="preview">' + (c.summary ? escHtml(c.summary.slice(0, 80)) : 'msgs since squash: ' + c.msgsSinceSquash + '/10') + '</div>'
      + '</div>'
      + '<div class="badge">' + fmtRel(c.updatedAt) + '</div>'
    + '</button>';
  }).join("") || '<div style="color:var(--text-dim);font-size:11px;padding:6px 10px;">no threads yet</div>';

  conv.querySelectorAll(".nav-item").forEach(el => {
    el.addEventListener("click", () => openPortal(el.dataset.id));
  });
  threadEl.querySelectorAll(".nav-item").forEach(el => {
    el.addEventListener("click", () => openThread(el.dataset.key));
  });

  $("st-contexts").textContent = state.contexts.length;
  $("st-replies").textContent = state.stats.totalReplies || 0;
  $("st-portal").textContent = state.stats.portalReplies || 0;
  const errs = state.stats.totalErrors || 0;
  const stE = $("st-errors");
  stE.textContent = errs;
  stE.style.color = errs > 0 ? "var(--bad)" : "";
}

function renderStats() {
  const items = [
    { label: "threads", value: state.stats.totalContexts || 0 },
    { label: "spawns", value: state.stats.totalSpawns || 0 },
    { label: "slack replies", value: state.stats.totalReplies || 0, cls: "good" },
    { label: "squashes", value: state.stats.totalSquashes || 0 },
    { label: "portal turns", value: state.stats.portalReplies || 0 },
    { label: "errors", value: state.stats.totalErrors || 0, cls: (state.stats.totalErrors || 0) > 0 ? "error" : "" },
  ];
  statGrid.innerHTML = items.map(i =>
    '<div class="stat-card ' + (i.cls || "") + '">'
    + '<div class="label">' + i.label + '</div>'
    + '<div class="value">' + i.value + '</div>'
    + '</div>'
  ).join("");
}

function activityRow(l) {
  const detail = Object.entries(l)
    .filter(([k]) => k !== "t" && k !== "kind")
    .map(([k, v]) => k + "=" + (typeof v === "string" ? v.slice(0, 40) : JSON.stringify(v)).slice(0, 40))
    .join(" ");
  return '<div class="activity-item ' + escHtml(l.kind || "") + '">'
    + '<div class="dot"></div>'
    + '<div class="ai-meta">'
      + '<div class="ai-kind">' + escHtml(l.kind || "?") + '</div>'
      + '<div class="ai-detail">' + escHtml(detail) + '</div>'
    + '</div>'
    + '<time>' + (l.t ? l.t.slice(11,19) : "") + '</time>'
  + '</div>';
}

function renderActivity() {
  activityEl.innerHTML = state.logs.slice(0, 60).map(activityRow).join("");
}

function pushLog(entry) {
  state.logs.unshift(entry);
  state.logs = state.logs.slice(0, 200);
  // Update stats counts roughly
  if (entry.kind === "replied") state.stats.totalReplies = (state.stats.totalReplies || 0) + 1;
  if (entry.kind === "spawn") state.stats.totalSpawns = (state.stats.totalSpawns || 0) + 1;
  if (entry.kind === "squashed") state.stats.totalSquashes = (state.stats.totalSquashes || 0) + 1;
  if (entry.kind === "portal_send") state.stats.portalSends = (state.stats.portalSends || 0) + 1;
  if (entry.kind === "portal_reply") state.stats.portalReplies = (state.stats.portalReplies || 0) + 1;
  if (entry.kind === "error" || entry.kind === "squash_failed" || entry.kind === "portal_error") {
    state.stats.totalErrors = (state.stats.totalErrors || 0) + 1;
  }
  // Prepend live to feed without full rerender
  const node = document.createElement("div");
  node.innerHTML = activityRow(entry);
  activityEl.prepend(node.firstChild);
  while (activityEl.children.length > 60) activityEl.removeChild(activityEl.lastChild);
  renderStats();
  // Top stat counters
  $("st-replies").textContent = state.stats.totalReplies || 0;
  $("st-portal").textContent = state.stats.portalReplies || 0;
  const errs = state.stats.totalErrors || 0;
  $("st-errors").textContent = errs;
  $("st-errors").style.color = errs > 0 ? "var(--bad)" : "";
}

// ---- Views ----
function showEmpty() {
  state.view = "empty";
  state.activeConvoId = null;
  state.activeThreadKey = null;
  paneTitle.textContent = "smaths-bot";
  paneSub.textContent = "pick a conversation or thread";
  paneActions.innerHTML = "";
  composer.style.display = "none";
  chat.innerHTML = '<div class="empty-state">'
    + '<div class="es-icon">✨</div>'
    + '<h3>Talk to smaths-bot</h3>'
    + '<p>Spin up a portal conversation, peek into a Slack thread, or just watch the live activity stream on the right.</p>'
    + '</div>';
  renderSidebar();
}

async function openPortal(id) {
  state.view = "portal";
  state.activeConvoId = id;
  state.activeThreadKey = null;
  state.streaming = false;
  state.streamingText = "";
  state.streamingTools = [];
  composer.style.display = "block";
  paneActions.innerHTML =
    '<button class="btn" id="rename-btn">Rename</button>'
    + '<button class="btn" id="reset-btn">Reset</button>'
    + '<button class="btn danger" id="delete-btn">Delete</button>';
  $("rename-btn").onclick = () => promptRename(id);
  $("reset-btn").onclick = () => doReset(id);
  $("delete-btn").onclick = () => doDelete(id);
  try {
    const data = await api("/portal.json?id=" + encodeURIComponent(id));
    state.currentMessages = data.messages || [];
    paneTitle.textContent = data.title || "untitled";
    paneSub.textContent = data.sessionId
      ? "session " + data.sessionId.slice(0, 8) + " · " + (data.messages?.length || 0) + " msgs"
      : "no session yet";
    renderChat();
    setTimeout(() => input.focus(), 50);
  } catch (e) {
    chat.innerHTML = '<div class="empty-state"><h3>Could not load</h3><p>' + escHtml(e.message) + '</p></div>';
  }
  renderSidebar();
}

async function openThread(key) {
  state.view = "thread";
  state.activeThreadKey = key;
  state.activeConvoId = null;
  composer.style.display = "none";
  paneActions.innerHTML = "";
  const ctx = state.contexts.find(c => c.key === key);
  if (!ctx) {
    chat.innerHTML = '<div class="empty-state"><h3>Thread not found</h3></div>';
    return;
  }
  paneTitle.textContent = "Slack thread";
  paneSub.textContent = ctx.channel + " / " + ctx.threadTs;
  const pct = Math.min(100, (ctx.msgsSinceSquash / 10) * 100);
  chat.innerHTML = '<div class="thread-detail">'
    + '<div class="detail-card">'
      + '<h4>Compaction progress</h4>'
      + '<dl class="kv">'
        + '<dt>Channel</dt><dd>' + escHtml(ctx.channel) + '</dd>'
        + '<dt>Thread ts</dt><dd>' + escHtml(ctx.threadTs) + '</dd>'
        + '<dt>Last activity</dt><dd>' + escHtml(new Date(ctx.updatedAt).toLocaleString()) + '</dd>'
        + '<dt>Msgs / squash</dt><dd>' + ctx.msgsSinceSquash + ' / 10</dd>'
        + '<dt>Folded through</dt><dd>' + escHtml(ctx.summarizedThrough || "—") + '</dd>'
      + '</dl>'
      + '<div class="progress"><div class="fill" style="width:' + pct + '%"></div></div>'
    + '</div>'
    + '<div class="detail-card">'
      + '<h4>Running summary</h4>'
      + '<div class="summary-text ' + (ctx.summary ? "" : "empty") + '">'
        + (ctx.summary ? escHtml(ctx.summary) : "No summary yet — needs more messages before squash kicks in.")
      + '</div>'
    + '</div>'
  + '</div>';
  renderSidebar();
}

function renderToolCard(t, idx) {
  const status = t.isError === true ? "error" : (t.isError === false ? "" : "running");
  const statusText = t.isError === true ? "error" : (t.isError === false ? "done" : "running…");
  const niceName = t.name.replace(/^mcp__slack__/, "🔧 slack/").replace(/^mcp__/, "");
  const inputJson = t.input ? JSON.stringify(t.input, null, 2) : "(no input)";
  return '<div class="tool-card ' + status + '" data-idx="' + idx + '">'
    + '<div class="tc-head">'
      + '<span class="tc-icon">⚙</span>'
      + '<span class="tc-name">' + escHtml(niceName) + '</span>'
      + '<span class="tc-status">' + statusText + '</span>'
      + '<span class="chev">›</span>'
    + '</div>'
    + '<div class="tc-body">'
      + '<pre>' + escHtml(inputJson) + '</pre>'
    + '</div>'
  + '</div>';
}

function renderChat() {
  if (!state.currentMessages.length && !state.streaming) {
    chat.innerHTML = '<div class="empty-state">'
      + '<div class="es-icon">💬</div>'
      + '<h3>Empty conversation</h3>'
      + '<p>Type below to start. smaths-bot can read Slack channels and threads, and post messages with your confirmation.</p>'
      + '</div>';
    return;
  }
  let html = '<div class="chat-stream">';
  for (const m of state.currentMessages) {
    html += renderMessage(m);
  }
  if (state.streaming) {
    html += renderStreamingMessage();
  }
  html += '</div>';
  chat.innerHTML = html;
  attachToolCardHandlers();
  chat.scrollTop = chat.scrollHeight;
}

function renderMessage(m) {
  const isUser = m.role === "user";
  const avatar = isUser ? "you" : "sb";
  const tools = (m.toolUses && m.toolUses.length)
    ? '<div class="tool-stack">' + m.toolUses.map(renderToolCard).join("") + '</div>'
    : "";
  const content = isUser
    ? '<div class="content">' + escHtml(m.text) + '</div>'
    : '<div class="content">' + renderMarkdown(m.text) + '</div>';
  return '<div class="msg ' + m.role + '">'
    + '<div class="avatar">' + avatar + '</div>'
    + '<div class="body">'
      + '<div class="who">' + (isUser ? "you" : "smaths-bot") + ' · ' + fmtTime(m.ts) + '</div>'
      + content
      + tools
    + '</div>'
  + '</div>';
}

function renderStreamingMessage() {
  const tools = state.streamingTools.length
    ? '<div class="tool-stack">' + state.streamingTools.map(renderToolCard).join("") + '</div>'
    : "";
  const text = state.streamingText
    ? '<div class="content">' + renderMarkdown(state.streamingText) + '</div>'
    : '<div class="content"><span class="thinking">thinking <span class="dots"><span></span><span></span><span></span></span></span></div>';
  return '<div class="msg assistant">'
    + '<div class="avatar">sb</div>'
    + '<div class="body">'
      + '<div class="who">smaths-bot · streaming…</div>'
      + text
      + tools
    + '</div>'
  + '</div>';
}

function attachToolCardHandlers() {
  chat.querySelectorAll(".tool-card .tc-head").forEach(h => {
    h.addEventListener("click", () => h.parentElement.classList.toggle("open"));
  });
}

// ---- Send loop ----
async function doSend(text) {
  if (!state.activeConvoId) return;
  state.currentMessages.push({ role: "user", text, ts: Date.now() });
  state.streaming = true;
  state.streamingText = "";
  state.streamingTools = [];
  renderChat();
  send.disabled = true;
  try {
    const res = await fetch("/portal/message" + tokParam, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, id: state.activeConvoId }),
    });
    if (!res.ok) {
      const err = await res.text();
      state.streaming = false;
      state.currentMessages.push({
        role: "assistant",
        text: "_(error: " + err.slice(0, 200) + ")_",
        ts: Date.now(),
      });
      renderChat();
      return;
    }
    const data = await res.json();
    // The 'done' event from SSE will land first if the connection is open and finalize state;
    // if SSE wasn't connected, fall back to the response payload.
    if (state.streaming) {
      state.streaming = false;
      state.currentMessages.push({
        role: "assistant",
        text: data.reply,
        ts: Date.now(),
        toolUses: data.toolUses || [],
      });
      renderChat();
    }
  } catch (e) {
    state.streaming = false;
    state.currentMessages.push({
      role: "assistant",
      text: "_(network error: " + e.message + ")_",
      ts: Date.now(),
    });
    renderChat();
  } finally {
    send.disabled = false;
    setTimeout(() => loadAll(), 200);
  }
}

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(200, input.scrollHeight) + "px";
});
input.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    submit();
  }
});
send.addEventListener("click", submit);
function submit() {
  const t = input.value.trim();
  if (!t) return;
  input.value = "";
  input.style.height = "auto";
  doSend(t);
}

// ---- Modal ----
function showModal({ title, desc, value }, onOk) {
  $("modal-title").textContent = title;
  $("modal-desc").textContent = desc || "";
  const i = $("modal-input");
  i.value = value || "";
  $("modal-bg").classList.add("show");
  setTimeout(() => i.focus(), 30);
  const close = () => $("modal-bg").classList.remove("show");
  $("modal-cancel").onclick = close;
  $("modal-ok").onclick = () => { close(); onOk(i.value.trim()); };
  i.onkeydown = (e) => { if (e.key === "Enter") { close(); onOk(i.value.trim()); } };
}

async function promptRename(id) {
  const p = state.portals.find(p => p.id === id);
  showModal({ title: "Rename conversation", desc: "Pick a short label.", value: p?.title || "" }, async (v) => {
    if (!v) return;
    await fetch("/portal/rename" + tokParam, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, title: v }),
    });
    await loadAll();
    if (state.view === "portal" && state.activeConvoId === id) paneTitle.textContent = v;
  });
}

async function doReset(id) {
  if (!confirm("Reset this conversation? Messages stay, but a new agent session starts.")) return;
  await fetch("/portal/reset" + tokParam, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  await loadAll();
  await openPortal(id);
}

async function doDelete(id) {
  if (!confirm("Delete this conversation forever?")) return;
  await fetch("/portal/delete" + tokParam, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id }),
  });
  await loadAll();
  showEmpty();
}

$("new-convo").addEventListener("click", async () => {
  const r = await fetch("/portal/create" + tokParam, { method: "POST" });
  const data = await r.json();
  await loadAll();
  await openPortal(data.id);
});

// ---- SSE ----
function connectStream() {
  const es = new EventSource("/stream" + tokParam);
  es.onopen = () => {
    conn.classList.add("live");
    connText.textContent = "live";
  };
  es.onerror = () => {
    conn.classList.remove("live");
    connText.textContent = "reconnecting…";
  };
  es.onmessage = (e) => {
    let evt;
    try { evt = JSON.parse(e.data); } catch { return; }
    handleEvent(evt);
  };
}

function handleEvent(evt) {
  if (evt.kind === "log") {
    pushLog(evt.data);
    // Slack thread state changed → reload contexts (debounced)
    if (["replied","squashed","spawn"].includes(evt.data.kind)) {
      scheduleSidebarReload();
    }
  }
  if (!state.activeConvoId || evt.convoId !== state.activeConvoId) return;
  if (evt.kind === "portal_assistant_start") {
    state.streaming = true;
    state.streamingText = "";
    state.streamingTools = [];
    renderChat();
  }
  if (evt.kind === "portal_assistant_delta") {
    state.streamingText += evt.chunk;
    // surgical update of the streaming bubble
    const bubble = chat.querySelector(".msg.assistant:last-child .content");
    if (bubble && state.streaming) {
      bubble.innerHTML = renderMarkdown(state.streamingText);
      chat.scrollTop = chat.scrollHeight;
    } else {
      renderChat();
    }
  }
  if (evt.kind === "portal_tool_use") {
    state.streamingTools.push({ name: evt.name, input: evt.input, isError: undefined });
    renderChat();
  }
  if (evt.kind === "portal_tool_result") {
    const last = [...state.streamingTools].reverse().find(t => t.name === evt.name && t.isError === undefined);
    if (last) last.isError = !!evt.isError;
    renderChat();
  }
  if (evt.kind === "portal_assistant_done") {
    state.streaming = false;
    state.currentMessages.push({
      role: "assistant",
      text: evt.text,
      ts: evt.ts,
      toolUses: state.streamingTools.slice(),
    });
    state.streamingText = "";
    state.streamingTools = [];
    renderChat();
    paneSub.textContent = evt.sessionId
      ? "session " + evt.sessionId.slice(0, 8) + " · " + state.currentMessages.length + " msgs"
      : "no session yet";
  }
  if (evt.kind === "portal_error") {
    state.streaming = false;
    state.currentMessages.push({
      role: "assistant",
      text: "_(error: " + evt.message + ")_",
      ts: evt.ts,
    });
    renderChat();
  }
}

let reloadTimer = null;
function scheduleSidebarReload() {
  if (reloadTimer) return;
  reloadTimer = setTimeout(async () => {
    reloadTimer = null;
    try {
      const dash = await api("/dashboard.json");
      state.contexts = dash.contexts || [];
      state.stats = dash.stats || {};
      renderSidebar();
      renderStats();
    } catch {}
  }, 600);
}

// ---- Boot ----
loadAll().then(() => {
  if (state.portals.length) {
    // open most recent portal by default
    openPortal(state.portals[0].id);
  } else {
    showEmpty();
  }
});
connectStream();
</script>
</body>
</html>`;
