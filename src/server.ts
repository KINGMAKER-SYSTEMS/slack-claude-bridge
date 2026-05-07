import "dotenv/config";
import Fastify from "fastify";
import { verifySlackSignature } from "./verify.js";
import { fetchChannel, fetchThread, postReply } from "./slack.js";
import { threadKey } from "./sessions.js";
import { runClaude } from "./spawn.js";
import {
  buildPrompt,
  loadContext,
  pickRecentSinceSummary,
  saveContext,
  shouldSquash,
  squash,
} from "./context.js";
import { log } from "./log.js";
import { getDashboardData, renderDashboardHtml } from "./dashboard.js";

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

const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || "";

function checkDashboardAuth(req: any): boolean {
  if (!DASHBOARD_TOKEN) {
    const ip = (req.headers["x-forwarded-for"] || req.ip || "").toString();
    return ip === "127.0.0.1" || ip === "::1" || ip.startsWith("127.");
  }
  const provided =
    req.query?.token ||
    (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  return provided === DASHBOARD_TOKEN;
}

app.get("/dashboard", async (req, reply) => {
  if (!checkDashboardAuth(req)) {
    return reply.code(401).type("text/plain").send("unauthorized");
  }
  const data = await getDashboardData();
  reply.type("text/html").send(renderDashboardHtml(data));
});

app.get("/dashboard.json", async (req, reply) => {
  if (!checkDashboardAuth(req)) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  return await getDashboardData();
});

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
    const rawMessages = inThread
      ? await fetchThread(channel, threadTs)
      : await fetchChannel(channel, 100);
    const messages = (rawMessages as any[])
      .filter((m) => typeof m.ts === "string")
      .map((m) => ({
        ts: m.ts as string,
        user: m.user,
        bot_id: m.bot_id,
        text: m.text,
      }));

    const ctx = await loadContext(key);
    const recent = pickRecentSinceSummary(messages, ctx.summarizedThrough);
    const newSinceLastSquash = ctx.summarizedThrough
      ? messages.filter((m) => Number(m.ts) > Number(ctx.summarizedThrough!))
          .length
      : messages.length;

    const latestText: string = event.text || "";
    const scopeLabel = inThread ? "Slack thread" : "Slack channel";
    const prompt = buildPrompt({
      scopeLabel,
      summary: ctx.summary,
      recent,
      latestText,
      botUserId: BOT_USER_ID,
    });

    await log({
      kind: "spawn",
      key,
      summaryChars: ctx.summary.length,
      recentMsgs: recent.length,
    });
    const result = await runClaude(prompt);

    const text = result.text || "(no response)";
    await postReply(channel, inThread ? threadTs : null, text);
    await log({ kind: "replied", key, chars: text.length, inThread });

    ctx.msgsSinceSquash = newSinceLastSquash;
    if (shouldSquash(ctx)) {
      const cutoff = ctx.summarizedThrough;
      const toFold = messages
        .filter((m) => !cutoff || Number(m.ts) > Number(cutoff))
        .sort((a, b) => Number(a.ts) - Number(b.ts));
      try {
        const newSummary = await squash({
          priorSummary: ctx.summary,
          messagesToFold: toFold,
          botUserId: BOT_USER_ID,
        });
        ctx.summary = newSummary;
        ctx.summarizedThrough =
          toFold[toFold.length - 1]?.ts || ctx.summarizedThrough;
        ctx.msgsSinceSquash = 0;
        await log({
          kind: "squashed",
          key,
          summaryChars: newSummary.length,
          foldedMsgs: toFold.length,
        });
      } catch (err) {
        await log({
          kind: "squash_failed",
          key,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
    ctx.updatedAt = Date.now();
    try {
      await saveContext(key, ctx);
    } catch (err) {
      await log({
        kind: "context_save_failed",
        key,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  } catch (err) {
    await log({
      kind: "error",
      key,
      message: err instanceof Error ? err.message : String(err),
    });
    try {
      await postReply(
        channel,
        inThread ? threadTs : null,
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
