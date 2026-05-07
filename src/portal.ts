import { promises as fs } from "node:fs";
import path from "node:path";
import { runAgentTurn } from "./agent.js";
import { log } from "./log.js";
import { bus } from "./events.js";

const PORTAL_DIR = process.env.PORTAL_DIR || "./data/portal";
const DEFAULT_CONVO_ID = "main";

export type PortalToolUse = {
  name: string;
  input?: any;
  ts: number;
  isError?: boolean;
};

export type PortalMsg = {
  role: "user" | "assistant";
  text: string;
  ts: number;
  toolUses?: PortalToolUse[];
};

export type PortalState = {
  id: string;
  title: string;
  sessionId: string | null;
  messages: PortalMsg[];
  createdAt: number;
  updatedAt: number;
};

export type PortalSummary = {
  id: string;
  title: string;
  messageCount: number;
  lastMessage: string;
  updatedAt: number;
};

async function ensureDir() {
  await fs.mkdir(PORTAL_DIR, { recursive: true });
}

function fileFor(id: string) {
  const safe = id.replace(/[^a-zA-Z0-9._-]/g, "_");
  return path.join(PORTAL_DIR, `${safe}.json`);
}

function defaultTitleFor(id: string) {
  return id === DEFAULT_CONVO_ID ? "main" : `chat ${id.slice(0, 6)}`;
}

export async function loadPortal(
  id: string = DEFAULT_CONVO_ID,
): Promise<PortalState> {
  await ensureDir();
  try {
    const raw = await fs.readFile(fileFor(id), "utf8");
    const parsed = JSON.parse(raw) as PortalState;
    if (!parsed.title) parsed.title = defaultTitleFor(id);
    if (!parsed.createdAt)
      parsed.createdAt = parsed.updatedAt || Date.now();
    return parsed;
  } catch {
    const now = Date.now();
    return {
      id,
      title: defaultTitleFor(id),
      sessionId: null,
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
  }
}

export async function savePortal(state: PortalState) {
  await ensureDir();
  await fs.writeFile(fileFor(state.id), JSON.stringify(state, null, 2));
}

export async function listPortals(): Promise<PortalSummary[]> {
  await ensureDir();
  const entries: PortalSummary[] = [];
  try {
    const files = await fs.readdir(PORTAL_DIR);
    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      try {
        const raw = await fs.readFile(path.join(PORTAL_DIR, f), "utf8");
        const data = JSON.parse(raw) as PortalState;
        const last = data.messages[data.messages.length - 1];
        entries.push({
          id: data.id,
          title: data.title || defaultTitleFor(data.id),
          messageCount: data.messages.length,
          lastMessage: last
            ? last.text.slice(0, 120).replace(/\s+/g, " ")
            : "",
          updatedAt: data.updatedAt || 0,
        });
      } catch {}
    }
  } catch {}
  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  if (!entries.find((e) => e.id === DEFAULT_CONVO_ID)) {
    const main = await loadPortal(DEFAULT_CONVO_ID);
    await savePortal(main);
    entries.unshift({
      id: main.id,
      title: main.title,
      messageCount: 0,
      lastMessage: "",
      updatedAt: main.updatedAt,
    });
  }
  return entries;
}

function makeId() {
  return `c_${Date.now().toString(36)}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

export async function createPortal(title?: string): Promise<PortalState> {
  const id = makeId();
  const now = Date.now();
  const fresh: PortalState = {
    id,
    title: title?.trim() || `chat ${new Date(now).toISOString().slice(11, 16)}`,
    sessionId: null,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  await savePortal(fresh);
  return fresh;
}

export async function renamePortal(id: string, title: string) {
  const state = await loadPortal(id);
  state.title = title.trim() || state.title;
  state.updatedAt = Date.now();
  await savePortal(state);
  return state;
}

export async function deletePortal(id: string) {
  if (id === DEFAULT_CONVO_ID) {
    return resetPortal(DEFAULT_CONVO_ID);
  }
  try {
    await fs.unlink(fileFor(id));
  } catch {}
  return { ok: true };
}

export async function resetPortal(id: string = DEFAULT_CONVO_ID) {
  const now = Date.now();
  const fresh: PortalState = {
    id,
    title: defaultTitleFor(id),
    sessionId: null,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  await savePortal(fresh);
  bus.emit({ kind: "portal_reset", convoId: id, ts: now });
  return fresh;
}

export async function sendPortalMessage(
  text: string,
  id: string = DEFAULT_CONVO_ID,
): Promise<{
  reply: string;
  toolUses: PortalToolUse[];
  sessionId: string | null;
  convoId: string;
}> {
  const state = await loadPortal(id);

  const userTs = Date.now();
  const userMsg: PortalMsg = {
    role: "user",
    text,
    ts: userTs,
  };
  state.messages.push(userMsg);
  state.updatedAt = userTs;
  if (
    state.messages.length === 1 &&
    (!state.title || state.title.startsWith("chat "))
  ) {
    state.title = text.slice(0, 60).replace(/\s+/g, " ").trim() || state.title;
  }
  await savePortal(state);
  bus.emit({ kind: "portal_user", convoId: id, text, ts: userTs });

  const toolUses: PortalToolUse[] = [];
  let assistantStreamed = "";

  await log({
    kind: "portal_send",
    convoId: id,
    chars: text.length,
    resume: !!state.sessionId,
  });

  bus.emit({
    kind: "portal_assistant_start",
    convoId: id,
    ts: Date.now(),
  });

  let result;
  try {
    result = await runAgentTurn({
      prompt: text,
      resumeSessionId: state.sessionId,
      onAssistantText: (chunk) => {
        assistantStreamed += chunk;
        bus.emit({
          kind: "portal_assistant_delta",
          convoId: id,
          chunk,
        });
      },
      onToolUse: ({ name, input }) => {
        const tu: PortalToolUse = { name, input, ts: Date.now() };
        toolUses.push(tu);
        bus.emit({
          kind: "portal_tool_use",
          convoId: id,
          name,
          input,
          ts: tu.ts,
        });
      },
      onToolResult: ({ name, isError }) => {
        const last = [...toolUses].reverse().find((t) => t.name === name);
        if (last) last.isError = !!isError;
        bus.emit({
          kind: "portal_tool_result",
          convoId: id,
          name,
          isError,
          ts: Date.now(),
        });
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    bus.emit({
      kind: "portal_error",
      convoId: id,
      message: msg,
      ts: Date.now(),
    });
    await log({ kind: "portal_error", convoId: id, message: msg });
    throw err;
  }

  if (result.sessionId) state.sessionId = result.sessionId;

  const replyText = result.text || assistantStreamed.trim() || "(no response)";
  const assistantMsg: PortalMsg = {
    role: "assistant",
    text: replyText,
    ts: Date.now(),
    toolUses: toolUses.length ? toolUses : undefined,
  };
  state.messages.push(assistantMsg);
  state.updatedAt = assistantMsg.ts;
  await savePortal(state);

  bus.emit({
    kind: "portal_assistant_done",
    convoId: id,
    text: replyText,
    sessionId: state.sessionId,
    ts: assistantMsg.ts,
  });

  await log({
    kind: "portal_reply",
    convoId: id,
    chars: replyText.length,
    toolCalls: toolUses.length,
    tokens: result.totalTokens,
    isError: result.isError,
  });

  return {
    reply: replyText,
    toolUses,
    sessionId: state.sessionId,
    convoId: id,
  };
}
