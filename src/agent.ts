import { z } from "zod";
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { McpStdioServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  fetchChannel,
  fetchThread,
  postReply,
  slack,
} from "./slack.js";

function loadSystemPrompt(): string {
  const path = resolve(
    process.env.SYSTEM_PROMPT_FILE || "./prompts/system.md",
  );
  if (existsSync(path)) {
    return readFileSync(path, "utf8").trim();
  }
  const fallback = resolve("./prompts/system.example.md");
  if (existsSync(fallback)) {
    return readFileSync(fallback, "utf8").trim();
  }
  return "You are a helpful agent.";
}

const PORTAL_PROMPT_SUFFIX = `

You are running inside the operator's Portal — a private web chat where they steer you. You have Slack tools to read channels, read threads, and post messages on behalf of the bot account.

Portal behavior:
- The operator may ask you to do things in Slack ("read #campaigns", "draft a reply for that thread", "post this in #eng").
- Always confirm before posting to Slack. Show the exact text you intend to post and the channel, then wait for an explicit "yes / send / go". Never post unprompted.
- When the operator asks for information from Slack, just go fetch it with your tools. Don't narrate ("let me check") — just call the tool, then summarize the result.
- The operator's Slack user ID and the bot's Slack user ID are passed in your environment. Never tag the bot user.
- If the operator says something ambiguous, ask one short clarifying question.

Tools available:
- slack_search_channels: list/search channels by name
- slack_read_channel: read recent messages from a channel
- slack_read_thread: read a thread's messages
- slack_post_message: post a message to a channel or thread (always requires operator confirmation first)
`;

const SLACK_PROMPT_SUFFIX = `

You are responding directly inside Slack as the bot. The user's message you're replying to was a mention of you in a channel or thread. The text you produce in this turn IS the reply that will be posted — there is no operator review step, no confirmation gate.

Slack reply behavior:
- Output the reply body only. No preamble ("here's the reply"), no meta-commentary, no narration of tool calls. Plain Slack markdown.
- Do not wait for "yes / send / go". There is no operator on the other side of this turn — this is a direct auto-reply.
- Use your tools (filesystem, git, web, etc.) freely if they help you answer. Don't post additional Slack messages — your final text in this turn is the message that gets posted.
- Be direct and grounded in real data. Match the operator's voice from the system prompt above.
`;

const SQUASH_PROMPT = `You summarize prior Slack conversation context. Output only the requested summary text — no preamble, no meta-commentary, no tool use. Just the summary.`;

function buildSlackTools() {
  const slackReadChannel = tool(
    "slack_read_channel",
    "Read the most recent messages from a Slack channel. Returns oldest-first.",
    {
      channel: z
        .string()
        .describe("Slack channel ID (e.g. C0XXXXXXX) or name without the #"),
      limit: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe("How many recent messages to fetch. Default 50, max 200."),
    },
    async ({ channel, limit }) => {
      const channelId = await resolveChannelId(channel);
      const messages = await fetchChannel(channelId, limit ?? 50);
      const text = messages
        .map((m: any) => {
          const who = m.bot_id ? `bot:${m.bot_id}` : `user:${m.user || "?"}`;
          const time = m.ts
            ? new Date(Number(m.ts) * 1000).toISOString()
            : "?";
          return `[${time}] [${who}] ${m.text || ""}`;
        })
        .join("\n");
      return {
        content: [
          {
            type: "text",
            text:
              text ||
              `(channel ${channelId} has no readable messages, or the bot isn't a member)`,
          },
        ],
      };
    },
  );

  const slackReadThread = tool(
    "slack_read_thread",
    "Read all messages in a Slack thread.",
    {
      channel: z.string().describe("Slack channel ID"),
      thread_ts: z
        .string()
        .describe("Slack thread timestamp (the parent message ts)"),
    },
    async ({ channel, thread_ts }) => {
      const channelId = await resolveChannelId(channel);
      const messages = await fetchThread(channelId, thread_ts);
      const text = messages
        .map((m: any) => {
          const who = m.bot_id ? `bot:${m.bot_id}` : `user:${m.user || "?"}`;
          const time = m.ts
            ? new Date(Number(m.ts) * 1000).toISOString()
            : "?";
          return `[${time}] [${who}] ${m.text || ""}`;
        })
        .join("\n");
      return {
        content: [
          { type: "text", text: text || "(thread has no messages)" },
        ],
      };
    },
  );

  const slackPostMessage = tool(
    "slack_post_message",
    "Post a message to a Slack channel or thread as the bot. ONLY call this after the operator has explicitly confirmed (yes / send / go). The operator must see the exact text and channel first.",
    {
      channel: z
        .string()
        .describe("Slack channel ID or name without the #"),
      text: z.string().describe("Message body to post. Plain Slack markdown."),
      thread_ts: z
        .string()
        .optional()
        .describe("Optional thread ts to reply inside an existing thread"),
    },
    async ({ channel, text, thread_ts }) => {
      const channelId = await resolveChannelId(channel);
      const ts = await postReply(channelId, thread_ts ?? null, text);
      return {
        content: [
          {
            type: "text",
            text: `Posted to ${channelId}${
              thread_ts ? ` (thread ${thread_ts})` : ""
            }. Message ts: ${ts || "unknown"}.`,
          },
        ],
      };
    },
  );

  const slackSearchChannels = tool(
    "slack_search_channels",
    "List Slack channels the bot is a member of. Optionally filter by a name substring.",
    {
      name_contains: z
        .string()
        .optional()
        .describe("Filter by name substring (case-insensitive)"),
    },
    async ({ name_contains }) => {
      const channels = await listBotChannels();
      const filtered = name_contains
        ? channels.filter((c) =>
            c.name.toLowerCase().includes(name_contains.toLowerCase()),
          )
        : channels;
      const text = filtered
        .map((c) => `${c.id}  #${c.name}${c.is_private ? "  (private)" : ""}`)
        .join("\n");
      return {
        content: [
          {
            type: "text",
            text:
              text ||
              "(bot is not a member of any channels, or filter matched nothing)",
          },
        ],
      };
    },
  );

  return [
    slackReadChannel,
    slackReadThread,
    slackPostMessage,
    slackSearchChannels,
  ];
}

async function resolveChannelId(input: string): Promise<string> {
  if (/^[CGD][A-Z0-9]+$/.test(input)) return input;
  const stripped = input.replace(/^#/, "");
  const channels = await listBotChannels();
  const match = channels.find(
    (c) => c.name.toLowerCase() === stripped.toLowerCase(),
  );
  if (match) return match.id;
  return input;
}

let channelCache: { at: number; data: { id: string; name: string; is_private: boolean }[] } = {
  at: 0,
  data: [],
};

async function listBotChannels() {
  const now = Date.now();
  if (channelCache.data.length && now - channelCache.at < 60_000) {
    return channelCache.data;
  }
  const result: { id: string; name: string; is_private: boolean }[] = [];
  let cursor: string | undefined;
  do {
    const res: any = await slack.conversations.list({
      limit: 200,
      types: "public_channel,private_channel,mpim,im",
      exclude_archived: true,
      cursor,
    });
    for (const c of res.channels || []) {
      if (c.is_member && c.id && c.name) {
        result.push({
          id: c.id,
          name: c.name,
          is_private: !!c.is_private,
        });
      }
    }
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);
  channelCache = { at: now, data: result };
  return result;
}

export type AgentTurnMode = "portal" | "slack" | "squash";

export type AgentTurnInput = {
  prompt: string;
  resumeSessionId?: string | null;
  abortSignal?: AbortSignal;
  /** One-shot situational brief injected into the system prompt for fresh sessions (portal only). */
  landingBrief?: string;
  /**
   * Which call site is invoking the turn. Controls system prompt framing and
   * whether Slack tools / landing brief are wired in.
   * - "portal" (default): operator-steering web chat. Slack tools available, must confirm before posting.
   * - "slack": bot is auto-replying to a Slack mention. Output text is the reply itself.
   * - "squash": pure summarization of prior conversation. No Slack tools, no landing brief, minimal framing.
   */
  mode?: AgentTurnMode;
  onAssistantText?: (chunk: string) => void;
  onToolUse?: (info: { name: string; input: any }) => void;
  onToolResult?: (info: { name: string; isError?: boolean }) => void;
};

export type AgentTurnResult = {
  text: string;
  sessionId: string | null;
  totalTokens?: number;
  isError: boolean;
};

const BASE_SYSTEM_PROMPT = loadSystemPrompt();

function buildSystemPrompt(opts?: {
  mode?: AgentTurnMode;
  landingBrief?: string;
}): string {
  const mode = opts?.mode ?? "portal";

  if (mode === "squash") {
    return SQUASH_PROMPT;
  }

  const suffix = mode === "slack" ? SLACK_PROMPT_SUFFIX : PORTAL_PROMPT_SUFFIX;
  const liveTools = ALLOWED_TOOLS.map((t) => `- ${t}`).join("\n");
  const liveSection = `\n\nLive tools available this session (authoritative — trust this list, not memory):\n${liveTools}`;
  // Landing brief is portal-only — Slack auto-replies don't need it (each reply
  // already gets the running summary + recent thread messages from context.ts).
  const landing =
    mode === "portal" && opts?.landingBrief
      ? `\n\nSession landing brief (current state at session start):\n${opts.landingBrief}`
      : "";
  return BASE_SYSTEM_PROMPT + suffix + liveSection + landing;
}

const slackMcp = createSdkMcpServer({
  name: "slack",
  version: "0.1.0",
  tools: buildSlackTools(),
});

// ---- External MCP servers (Linear, Notion) ----
//
// Wired in via stdio. Each server is conditional on its auth env var being
// present in .env — missing env var => server skipped at boot with a warning,
// not a 5s connect-timeout on every Slack mention.
//
// Package-name choices documented here so they can be swapped without
// re-deriving:
// - Linear: `@tacticlaunch/mcp-linear` — community npm package that accepts
//   a Linear personal API key (`LINEAR_API_KEY`, prefix `lin_api_...`).
//   Alternates if this one misbehaves:
//     * `mcp-remote https://mcp.linear.app/sse` — Linear's official remote
//       MCP, OAuth-only, requires an interactive auth handshake on first run
//       (not headless-friendly for a daemon like smaths-bot).
//     * Any other community linear-mcp on npm that accepts an API key.
// - Notion: `@notionhq/notion-mcp-server` — Notion's official package. Auth
//   contract is `OPENAPI_MCP_HEADERS` (a JSON-stringified blob of HTTP
//   headers). `NOTION_TOKEN` is set as a secondary env var for forward-compat
//   with any future release that reads the token directly.
//
// Tool-name enumeration mirrors what each server emits at connect time. If
// the upstream package adds/removes tools, this list needs to follow — the
// SDK gates calls on exact names, so an unlisted tool from the server simply
// won't be callable by the model.

type ExternalMcpName = "linear" | "notion";

const EXTERNAL_MCP_TOOL_NAMES: Record<ExternalMcpName, readonly string[]> = {
  linear: [
    "mcp__linear__list_issues",
    "mcp__linear__get_issue",
    "mcp__linear__save_issue",
    "mcp__linear__save_comment",
    "mcp__linear__list_comments",
    "mcp__linear__list_teams",
    "mcp__linear__list_projects",
    "mcp__linear__list_users",
    "mcp__linear__list_issue_labels",
    "mcp__linear__list_issue_statuses",
  ],
  notion: [
    "mcp__notion__notion-search",
    "mcp__notion__notion-fetch",
    "mcp__notion__notion-create-pages",
    "mcp__notion__notion-update-page",
    "mcp__notion__notion-get-users",
    "mcp__notion__notion-get-teams",
    "mcp__notion__notion-create-comment",
    "mcp__notion__notion-get-comments",
  ],
};

function buildExternalMcpServers(): {
  servers: Record<string, McpStdioServerConfig>;
  enabled: ExternalMcpName[];
} {
  const servers: Record<string, McpStdioServerConfig> = {};
  const enabled: ExternalMcpName[] = [];

  const linearKey = process.env.LINEAR_API_KEY;
  if (linearKey) {
    servers.linear = {
      command: "npx",
      args: ["-y", "@tacticlaunch/mcp-linear"],
      env: { LINEAR_API_KEY: linearKey },
    };
    enabled.push("linear");
  } else {
    console.warn(
      "[smaths-bot] LINEAR_API_KEY missing — Linear MCP disabled. Add it to .env and restart to enable.",
    );
  }

  const notionToken = process.env.NOTION_TOKEN;
  if (notionToken) {
    servers.notion = {
      command: "npx",
      args: ["-y", "@notionhq/notion-mcp-server"],
      env: {
        OPENAPI_MCP_HEADERS: JSON.stringify({
          Authorization: `Bearer ${notionToken}`,
          "Notion-Version": "2022-06-28",
        }),
        NOTION_TOKEN: notionToken,
      },
    };
    enabled.push("notion");
  } else {
    console.warn(
      "[smaths-bot] NOTION_TOKEN missing — Notion MCP disabled. Add it to .env and restart to enable.",
    );
  }

  return { servers, enabled };
}

const externalMcp = buildExternalMcpServers();

const ALLOWED_TOOLS = [
  "mcp__slack__slack_read_channel",
  "mcp__slack__slack_read_thread",
  "mcp__slack__slack_post_message",
  "mcp__slack__slack_search_channels",
  "Bash",
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  // External MCP tools — only included if the corresponding server is
  // enabled (i.e. its auth env var is set). When disabled, the names are
  // omitted from both the allowlist and the system-prompt "live tools"
  // section, so the model doesn't pitch tools it can't actually call.
  ...externalMcp.enabled.flatMap((name) => EXTERNAL_MCP_TOOL_NAMES[name]),
];

export async function runAgentTurn(
  input: AgentTurnInput,
): Promise<AgentTurnResult> {
  let assistantText = "";
  let sessionId: string | null = input.resumeSessionId ?? null;
  let totalTokens: number | undefined;
  let isError = false;

  const mode: AgentTurnMode = input.mode ?? "portal";
  // Squash is pure summarization — don't wire in Slack tools, don't allow any
  // tool use at all. Forces the model to just produce the summary text.
  const isSquash = mode === "squash";

  const queryResult = query({
    prompt: input.prompt,
    options: {
      cwd: process.cwd(),
      systemPrompt: buildSystemPrompt({
        mode,
        landingBrief: input.landingBrief,
      }),
      mcpServers: isSquash ? {} : { slack: slackMcp, ...externalMcp.servers },
      allowedTools: isSquash ? [] : ALLOWED_TOOLS,
      tools: isSquash
        ? []
        : ["Bash", "Read", "Glob", "Grep", "WebFetch", "WebSearch"],
      resume: input.resumeSessionId ?? undefined,
      abortController: input.abortSignal
        ? wrapSignal(input.abortSignal)
        : undefined,
    },
  });

  for await (const message of queryResult) {
    if (message.type === "system" && (message as any).session_id) {
      if (!sessionId) sessionId = (message as any).session_id;
    }
    if (message.type === "assistant") {
      const content = (message as any).message?.content || [];
      for (const block of content) {
        if (block.type === "text" && block.text) {
          assistantText += block.text;
          input.onAssistantText?.(block.text);
        }
        if (block.type === "tool_use") {
          input.onToolUse?.({ name: block.name, input: block.input });
        }
      }
    }
    if (message.type === "user") {
      const content = (message as any).message?.content || [];
      for (const block of content) {
        if (block.type === "tool_result") {
          input.onToolResult?.({
            name: block.name || "",
            isError: !!block.is_error,
          });
        }
      }
    }
    if (message.type === "result") {
      const r: any = message;
      if (r.session_id && !sessionId) sessionId = r.session_id;
      if (r.usage) {
        totalTokens =
          (r.usage.input_tokens || 0) + (r.usage.output_tokens || 0);
      }
      if (r.subtype && r.subtype !== "success") {
        isError = true;
      }
      if (typeof r.result === "string" && r.result.length > assistantText.length) {
        assistantText = r.result;
      }
    }
  }

  return {
    text: assistantText.trim(),
    sessionId,
    totalTokens,
    isError,
  };
}

function wrapSignal(signal: AbortSignal): AbortController {
  const ctrl = new AbortController();
  if (signal.aborted) ctrl.abort();
  signal.addEventListener("abort", () => ctrl.abort());
  return ctrl;
}
