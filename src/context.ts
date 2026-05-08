import { promises as fs } from "node:fs";
import path from "node:path";
import { runAgentTurn } from "./agent.js";

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

  // Goes through the Agent SDK with mode:"squash" — pure summarization,
  // no Slack tools, no Portal framing, no landing brief. The standalone
  // `claude -p` CLI is broken in 2.0.56 (returns error_during_execution
  // with empty output before the API call fires).
  const result = await runAgentTurn({
    prompt,
    resumeSessionId: null,
    mode: "squash",
  });
  const trimmed = result.text.trim();
  if (!trimmed) {
    throw new Error(
      `squash produced empty summary (isError=${result.isError})`,
    );
  }
  return trimmed;
}
