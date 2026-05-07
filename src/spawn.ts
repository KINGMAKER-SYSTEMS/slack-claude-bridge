import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

export type ClaudeResult = {
  text: string;
  sessionId: string | null;
};

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
  return "You are responding inside Slack on behalf of your operator. Be direct and grounded in real data.";
}

const SYSTEM_PROMPT = loadSystemPrompt();

export async function runClaude(prompt: string): Promise<ClaudeResult> {
  return new Promise((resolve, reject) => {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--append-system-prompt",
      SYSTEM_PROMPT,
      prompt,
    ];

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
