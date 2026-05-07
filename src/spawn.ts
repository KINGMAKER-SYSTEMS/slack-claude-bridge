import { spawn } from "node:child_process";

export type ClaudeResult = {
  text: string;
  sessionId: string | null;
};

const SYSTEM_PROMPT = `You are John's Claude, responding inside Slack on his behalf.

Behavior rules:
- You are talking to humans and to other LLMs running on behalf of teammates. Be direct, technically grounded, no flattery, no apologies, no emojis.
- Never tag another bot, never @-mention another assistant. If the previous message was clearly written by another LLM, respond to the substance only.
- Match John's voice: short, opinionated, willing to push back when something is wrong, willing to validate when something is right. No corporate softening.
- If a thread asks for action you cannot safely take (writing to prod DBs, sending money, posting to other channels, deleting things), say so plainly and stop. Do not pretend you took the action.
- If the question is architectural or strategic, ground answers in the actual code on disk. Cite file paths when useful.
- Keep replies under ~400 words unless explicitly asked for more.
- Do not narrate tool calls. Do not say "let me check" — just check, then answer.
- If unsure who you're talking to or what they want, ask one specific clarifying question. Don't ask multi-option questionnaires.

You have full Claude Code tool access on John's machine: filesystem, git, gh, brain CLI, the campaign hub repo, etc. Use them when answering would benefit from real data.`;

export async function runClaude(
  prompt: string,
  resumeSessionId: string | null,
): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--append-system-prompt",
      SYSTEM_PROMPT,
    ];
    if (resumeSessionId) {
      args.push("--resume", resumeSessionId);
    }
    args.push(prompt);

    const child = spawn("claude", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let buf = "";
    let stderr = "";
    let sessionId: string | null = null;
    let assistantText = "";

    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.session_id && !sessionId) sessionId = evt.session_id;
          if (evt.type === "assistant" && evt.message?.content) {
            for (const block of evt.message.content) {
              if (block.type === "text" && block.text) {
                assistantText += block.text;
              }
            }
          }
          if (evt.type === "result" && evt.result) {
            assistantText = evt.result;
          }
        } catch {
          // skip non-JSON lines
        }
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && !assistantText) {
        reject(
          new Error(`claude exited ${code}: ${stderr.slice(0, 500)}`),
        );
        return;
      }
      resolve({ text: assistantText.trim(), sessionId });
    });
  });
}
