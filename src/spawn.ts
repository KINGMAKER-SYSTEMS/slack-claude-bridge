import { runAgentTurn } from "./agent.js";

export type ClaudeResult = {
  text: string;
  sessionId: string | null;
};

/**
 * One-shot Claude turn for the Slack bridge. Replaces the previous
 * `claude -p` subprocess (broken in Claude Code 2.0.56 — it returns
 * `error_during_execution` with empty output before the API call even
 * fires). Now goes through the same Agent SDK path the portal uses,
 * but with `mode: 'slack'` so the system prompt frames the model as
 * an auto-reply — no operator-confirmation gating, no Portal framing.
 *
 * The Slack code path doesn't need session resumption — each Slack
 * mention rebuilds its prompt from the running summary + recent messages
 * (see context.ts), so we always start fresh here.
 */
export async function runClaude(prompt: string): Promise<ClaudeResult> {
  const result = await runAgentTurn({
    prompt,
    resumeSessionId: null,
    mode: "slack",
  });
  return {
    text: result.text,
    sessionId: result.sessionId,
  };
}
