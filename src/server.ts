import "dotenv/config";
import Fastify from "fastify";
import { verifySlackSignature } from "./verify.js";
import { fetchChannel, fetchThread, postReply } from "./slack.js";
import { getSession, setSession, threadKey } from "./sessions.js";
import { runClaude } from "./spawn.js";
import { log } from "./log.js";

const PORT = Number(process.env.PORT || 3737);
const BOT_USER_ID = process.env.SLACK_BOT_USER_ID || "";
const ALLOWED = new Set(
  (process.env.ALLOWED_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const app = Fastify({ logger: false });

app.addContentTypeParser(
  "application/json",
  { parseAs: "string" },
  (_req, body, done) => {
    try {
      done(null, { raw: body, parsed: JSON.parse(body as string) });
    } catch (err) {
      done(err as Error, undefined);
    }
  },
);

app.get("/health", async () => ({ ok: true }));

const inFlight = new Set<string>();

app.post("/slack/events", async (req, reply) => {
  const headers = req.headers;
  const body = req.body as { raw: string; parsed: any };
  const ok = verifySlackSignature(
    body.raw,
    headers["x-slack-request-timestamp"] as string | undefined,
    headers["x-slack-signature"] as string | undefined,
  );
  if (!ok) {
    return reply.code(401).send({ error: "bad signature" });
  }

  const payload = body.parsed;

  if (payload.type === "url_verification") {
    return reply.send({ challenge: payload.challenge });
  }

  reply.send({ ok: true });

  if (payload.type !== "event_callback") return;
  const event = payload.event;
  if (!event) return;
  if (event.type !== "app_mention" && event.type !== "message") return;
  if (event.type === "message" && (event.subtype || event.bot_id)) return;
  if (event.user === BOT_USER_ID) return;
  if (event.bot_id) return;

  const isMention =
    event.type === "app_mention" ||
    (BOT_USER_ID && (event.text || "").includes(`<@${BOT_USER_ID}>`));
  if (!isMention) return;

  if (ALLOWED.size > 0 && event.user && !ALLOWED.has(event.user)) {
    await log({ kind: "blocked_user", user: event.user });
    return;
  }

  const channel: string = event.channel;
  const threadTs: string = event.thread_ts || event.ts;
  const key = threadKey(channel, threadTs);
  const inThread = !!event.thread_ts;

  if (inFlight.has(key)) {
    await log({ kind: "drop_concurrent", key });
    return;
  }
  inFlight.add(key);

  try {
    const messages = inThread
      ? await fetchThread(channel, threadTs)
      : await fetchChannel(channel, 100);
    const transcript = messages
      .map((m: any) => {
        const who = m.bot_id ? `bot:${m.bot_id}` : `user:${m.user}`;
        return `[${who}] ${m.text || ""}`;
      })
      .join("\n\n");

    const latestText: string = event.text || "";
    const scopeLabel = inThread ? "Slack thread" : "Slack channel";
    const transcriptLabel = inThread
      ? "Thread transcript (oldest first):"
      : "Recent channel messages (oldest first, last 100):";
    const prompt = `You are responding inside a ${scopeLabel}.

${transcriptLabel}
---
${transcript}
---

Latest message that mentioned you:
${latestText}

Write the reply text only. Plain Slack markdown. No preamble, no "here is your reply" framing — just the message body that should be posted.`;

    const existing = await getSession(key);
    await log({ kind: "spawn", key, resume: !!existing });
    const result = await runClaude(prompt, existing);
    if (result.sessionId) await setSession(key, result.sessionId);

    const text = result.text || "(no response)";
    await postReply(channel, threadTs, text);
    await log({ kind: "replied", key, chars: text.length });
  } catch (err) {
    await log({
      kind: "error",
      key,
      message: err instanceof Error ? err.message : String(err),
    });
    try {
      await postReply(
        channel,
        threadTs,
        `_(bridge error — check logs)_`,
      );
    } catch {}
  } finally {
    inFlight.delete(key);
  }
});

app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
  log({ kind: "boot", port: PORT });
});
