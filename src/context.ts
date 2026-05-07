import { promises as fs } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const CONTEXTS_DIR = process.env.CONTEXTS_DIR || "./data/contexts";
const WINDOW_SIZE = Number(process.env.CONTEXT_WINDOW_SIZE || 10);
const SQUASH_THRESHOLD = Number(process.env.CONTEXT_SQUASH_THRESHOLD || 10);

export type ContextState = {
  summary: string;
  summarizedThrough: string | null;
  msgsSinceSquash: number;
  updatedAt: number;
};

export type SlackMsg = {
  ts: string;
  user?: string;
  bot_id?: string;
  text?: string;
};

function fileFor(key: string) {
  return path.join(CONTEXTS_DIR, `${key.replace(/[^a-zA-Z0-9._:-]/g, "_")}.json`);
}

async function ensureDir() {
  await fs.mkdir(CONTEXTS_DIR, { recursive: true });
}

export async function loadContext(key: string): Promise<ContextState> {
  await ensureDir();
  try {
    const raw = await fs.readFile(fileFor(key), "utf8");
    return JSON.parse(raw) as ContextState;
  } catch {
    return {
      summary: "",
      summarizedThrough: null,
      msgsSinceSquash: 0,
      updatedAt: Date.now(),
    };
  }
}

export async function saveContext(key: string, state: ContextState) {
  await ensureDir();
  await fs.writeFile(fileFor(key), JSON.stringify(state, null, 2));
}

export function buildPrompt(opts: {
  scopeLabel: string;
  summary: string;
  recent: SlackMsg[];
  latestText: string;
  botUserId: string;
}) {
  const { scopeLabel, summary, recent, latestText, botUserId } = opts;
  const transcript = recent
    .map((m) => {
      const who = m.bot_id
        ? `bot:${m.bot_id}`
        : m.user === botUserId
          ? `you`
          : `user:${m.user}`;
      return `[${who}] ${m.text || ""}`;
    })
    .join("\n\n");

  const summaryBlock = summary
    ? `Running summary of older history (older than the messages below):
---
${summary}
---

`
    : "";

  return `You are responding inside a ${scopeLabel}.

${summaryBlock}Last ${recent.length} messages (oldest first):
---
${transcript}
---

Latest message that mentioned you:
${latestText}

Write the reply text only. Plain Slack markdown. No preamble, no "here is your reply" framing — just the message body that should be posted.`;
}

export function pickRecentSinceSummary(
  messages: SlackMsg[],
  summarizedThrough: string | null,
): SlackMsg[] {
  const sorted = [...messages].sort((a, b) =>
    Number(a.ts) - Number(b.ts),
  );
  const fresh = summarizedThrough
    ? sorted.filter((m) => Number(m.ts) > Number(summarizedThrough))
    : sorted;
  return fresh.slice(-WINDOW_SIZE);
}

export function shouldSquash(state: ContextState): boolean {
  return state.msgsSinceSquash >= SQUASH_THRESHOLD;
}

export async function squash(opts: {
  priorSummary: string;
  messagesToFold: SlackMsg[];
  botUserId: string;
}): Promise<string> {
  const { priorSummary, messagesToFold, botUserId } = opts;
  if (messagesToFold.length === 0) return priorSummary;

  const transcript = messagesToFold
    .map((m) => {
      const who = m.bot_id
        ? `bot:${m.bot_id}`
        : m.user === botUserId
          ? `you`
          : `user:${m.user}`;
      return `[${who}] ${m.text || ""}`;
    })
    .join("\n\n");

  const prompt = `You maintain a running summary of a Slack conversation so future replies have context without exploding token usage.

Prior summary (may be empty):
---
${priorSummary || "(none yet)"}
---

New messages to fold in (oldest first):
---
${transcript}
---

Produce an updated summary, max 500 tokens, preserving:
- Names of people involved and their roles
- Decisions made
- Open questions or unresolved threads
- File paths, repo names, URLs, ticket IDs explicitly mentioned
- Anything the bot agreed to do or remember

Drop pleasantries, off-topic asides, redundant restatements. Replace the prior summary entirely — do not append. Output the new summary text only.`;

  return new Promise<string>((resolve, reject) => {
    const child = spawn(
      "claude",
      ["-p", "--output-format", "stream-json", "--verbose", prompt],
      { stdio: ["ignore", "pipe", "pipe"], env: process.env },
    );
    let buf = "";
    let stderr = "";
    let result = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.type === "assistant" && evt.message?.content) {
            for (const block of evt.message.content) {
              if (block.type === "text" && block.text) {
                result += block.text;
              }
            }
          }
          if (evt.type === "result" && evt.result) {
            result = evt.result;
          }
        } catch {
          // skip
        }
      }
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && !result) {
        reject(new Error(`squash claude exited ${code}: ${stderr.slice(0, 300)}`));
        return;
      }
      const trimmed = result.trim();
      if (!trimmed) {
        // Claude exited cleanly but produced no summary text. Surface this
        // as an error so the caller can log it properly instead of silently
        // overwriting a real prior summary with an empty string.
        reject(
          new Error(
            `squash produced empty summary (code=${code}, stderr=${stderr.slice(0, 200)})`,
          ),
        );
        return;
      }
      resolve(trimmed);
    });
  });
}
