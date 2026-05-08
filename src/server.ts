import "dotenv/config";
import { createReadStream } from "node:fs";
import { stat as fsStat } from "node:fs/promises";
import { resolve as pathResolve, normalize as pathNormalize } from "node:path";
import Fastify from "fastify";
import { verifySlackSignature } from "./verify.js";
import {
  addReaction,
  fetchChannel,
  fetchThread,
  postReply,
  removeReaction,
  updateMessage,
} from "./slack.js";
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
import { getDashboardData, renderAppHtml } from "./dashboard.js";
import {
  createPortal,
  deletePortal,
  listPortals,
  loadPortal,
  renamePortal,
  resetPortal,
  sendPortalMessage,
} from "./portal.js";
import { bus } from "./events.js";
import { getGitDiff, getGitStatus } from "./git.js";

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

// ---- PWA assets ----
//
// iOS Safari treats the dashboard as installable to Home Screen given a
// manifest + apple-touch-icon. start_url has to carry the dashboard token
// so the standalone app loads authenticated; if the token is rotated, the
// home-screen icon will need to be re-added.

const ICONS_DIR = pathResolve("./public/icons");

app.get("/manifest.webmanifest", async (req, reply) => {
  if (!checkDashboardAuth(req)) {
    return reply.code(401).type("text/plain").send("unauthorized");
  }
  const token = ((req.query as any)?.token as string) || DASHBOARD_TOKEN || "";
  const startQuery = token ? `?token=${encodeURIComponent(token)}` : "";
  const manifest = {
    name: "Smaths Bot",
    short_name: "SmathsBot",
    description: "smaths-bot HQ — Slack-Claude bridge dashboard + portal.",
    start_url: `/app${startQuery}`,
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    theme_color: "#a78bfa",
    background_color: "#0a0a0c",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icons/icon-512-maskable.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
  reply
    .type("application/manifest+json")
    .header("cache-control", "no-cache")
    .send(manifest);
});

// Icons are public assets — no auth gate. iOS Safari can't pass the token
// when fetching apple-touch-icon, and PWA manifest icons are conventionally
// open. There's nothing sensitive in the PNGs themselves.
app.get("/icons/:file", async (req, reply) => {
  const file = (req.params as any).file as string;
  // Reject anything that isn't a plain PNG filename — defense against
  // path traversal even though we resolve+containment-check below.
  if (!/^[a-zA-Z0-9._-]+\.png$/.test(file)) {
    return reply.code(404).send("not found");
  }
  const full = pathNormalize(pathResolve(ICONS_DIR, file));
  if (!full.startsWith(ICONS_DIR + "/") && full !== ICONS_DIR) {
    return reply.code(404).send("not found");
  }
  try {
    await fsStat(full);
  } catch {
    return reply.code(404).send("not found");
  }
  reply
    .type("image/png")
    .header("cache-control", "public, max-age=86400")
    .send(createReadStream(full));
});

// Tiny network-passthrough service worker. Doesn't cache anything — the
// dashboard reads streaming SSE and a frequently-updating dataset, so a
// stale-while-revalidate strategy would do more harm than good. iOS doesn't
// require this for install; it's here so Chrome Android (and Lighthouse)
// stop complaining and the page is technically a "real" PWA.
app.get("/sw.js", async (_req, reply) => {
  const sw = `// smaths-bot HQ service worker — passthrough only.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
`;
  reply
    .type("application/javascript")
    .header("cache-control", "no-cache")
    .send(sw);
});

// ---- App shell ----

app.get("/", async (_req, reply) => {
  reply.redirect("/app" + (DASHBOARD_TOKEN ? "?token=" + encodeURIComponent(DASHBOARD_TOKEN) : ""));
});

app.get("/app", async (req, reply) => {
  if (!checkDashboardAuth(req)) {
    return reply.code(401).type("text/plain").send("unauthorized");
  }
  const token = ((req.query as any)?.token as string) || DASHBOARD_TOKEN || "";
  reply.type("text/html").send(renderAppHtml(token));
});

// Back-compat redirects so old bookmarks still work
app.get("/dashboard", async (req, reply) => {
  if (!checkDashboardAuth(req)) {
    return reply.code(401).type("text/plain").send("unauthorized");
  }
  const token = ((req.query as any)?.token as string) || DASHBOARD_TOKEN || "";
  reply.redirect("/app" + (token ? "?token=" + encodeURIComponent(token) : ""));
});

app.get("/portal", async (req, reply) => {
  if (!checkDashboardAuth(req)) {
    return reply.code(401).type("text/plain").send("unauthorized");
  }
  const token = ((req.query as any)?.token as string) || DASHBOARD_TOKEN || "";
  reply.redirect("/app" + (token ? "?token=" + encodeURIComponent(token) : ""));
});

app.get("/dashboard.json", async (req, reply) => {
  if (!checkDashboardAuth(req)) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  return await getDashboardData();
});

// ---- Portal data + actions ----

app.get("/portal.json", async (req, reply) => {
  if (!checkDashboardAuth(req)) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  const id = ((req.query as any)?.id as string) || "main";
  return await loadPortal(id);
});

app.get("/portal/list", async (req, reply) => {
  if (!checkDashboardAuth(req)) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  return await listPortals();
});

app.post("/portal/message", async (req, reply) => {
  if (!checkDashboardAuth(req)) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  const body = req.body as { raw?: string; parsed?: any };
  const parsed = body?.parsed ?? {};
  const text = String(parsed.text || "").trim();
  const id = String(parsed.id || "main");
  if (!text) {
    return reply.code(400).send({ error: "text required" });
  }
  try {
    const result = await sendPortalMessage(text, id);
    return result;
  } catch (err) {
    await log({
      kind: "portal_error",
      convoId: id,
      message: err instanceof Error ? err.message : String(err),
    });
    return reply
      .code(500)
      .send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/portal/create", async (req, reply) => {
  if (!checkDashboardAuth(req)) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  const body = req.body as { parsed?: any };
  const title = body?.parsed?.title;
  return await createPortal(title);
});

app.post("/portal/rename", async (req, reply) => {
  if (!checkDashboardAuth(req)) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  const body = req.body as { parsed?: any };
  const id = String(body?.parsed?.id || "");
  const title = String(body?.parsed?.title || "");
  if (!id || !title) return reply.code(400).send({ error: "id and title required" });
  return await renamePortal(id, title);
});

app.post("/portal/delete", async (req, reply) => {
  if (!checkDashboardAuth(req)) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  const body = req.body as { parsed?: any };
  const id = String(body?.parsed?.id || "");
  if (!id) return reply.code(400).send({ error: "id required" });
  return await deletePortal(id);
});

app.post("/portal/reset", async (req, reply) => {
  if (!checkDashboardAuth(req)) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  const body = req.body as { parsed?: any };
  const id = String(body?.parsed?.id || "main");
  return await resetPortal(id);
});

// ---- Git status (read-only, phase 1) ----
//
// Reports on the cwd of the bridge process — the working directory it was
// started from. Repo / worktree selection lands in a later phase; for now,
// "where the server runs from" is "the active repo" and that's that.

app.get("/git/status", async (req, reply) => {
  if (!checkDashboardAuth(req)) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  return await getGitStatus(process.cwd());
});

app.get("/git/diff", async (req, reply) => {
  if (!checkDashboardAuth(req)) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  return await getGitDiff(process.cwd());
});

// ---- SSE live stream ----

app.get("/stream", async (req, reply) => {
  if (!checkDashboardAuth(req)) {
    return reply.code(401).send({ error: "unauthorized" });
  }
  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  reply.raw.write(": connected\n\n");

  const send = (event: any) => {
    try {
      reply.raw.write("data: " + JSON.stringify(event) + "\n\n");
    } catch {}
  };
  const unsub = bus.subscribe(send);
  const ping = setInterval(() => {
    try {
      reply.raw.write(": ping\n\n");
    } catch {}
  }, 25_000);

  req.raw.on("close", () => {
    clearInterval(ping);
    unsub();
    try {
      reply.raw.end();
    } catch {}
  });
});

// ---- Slack events ----

const inFlight = new Set<string>();

// Dedup Slack event deliveries. Slack retries on missed/slow ACKs and may also
// double-deliver. Drop anything we've already seen by event_id within a 5min window.
const EVENT_DEDUP_TTL_MS = 5 * 60_000;
const EVENT_DEDUP_MAX = 5000;
const seenEventIds = new Map<string, number>();
function pruneSeenEventIds() {
  const cutoff = Date.now() - EVENT_DEDUP_TTL_MS;
  for (const [id, ts] of seenEventIds) {
    if (ts < cutoff) seenEventIds.delete(id);
  }
  if (seenEventIds.size > EVENT_DEDUP_MAX) {
    const overflow = seenEventIds.size - EVENT_DEDUP_MAX;
    let i = 0;
    for (const id of seenEventIds.keys()) {
      if (i++ >= overflow) break;
      seenEventIds.delete(id);
    }
  }
}

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

  // If Slack is retrying, the first delivery either succeeded or is in flight
  // and we don't want to process it again.
  const retryNum = headers["x-slack-retry-num"];
  if (retryNum) {
    await log({
      kind: "drop_retry",
      retryNum: String(retryNum),
      reason: String(headers["x-slack-retry-reason"] || ""),
      eventId: payload.event_id,
    });
    return;
  }

  // Drop exact duplicate event deliveries.
  const eventId: string | undefined = payload.event_id;
  if (eventId) {
    if (seenEventIds.has(eventId)) {
      await log({ kind: "drop_duplicate", eventId });
      return;
    }
    seenEventIds.set(eventId, Date.now());
    pruneSeenEventIds();
  }

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

  const eventTs: string = event.ts;
  let placeholderTs: string | undefined;
  let reacted = false;
  try {
    await addReaction(channel, eventTs, "eyes");
    reacted = true;
  } catch (err) {
    await log({
      kind: "reaction_failed",
      key,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    placeholderTs = await postReply(
      channel,
      inThread ? threadTs : null,
      "_typing…_",
    );
  } catch (err) {
    await log({
      kind: "placeholder_failed",
      key,
      message: err instanceof Error ? err.message : String(err),
    });
  }

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

    const text = result.text.trim();

    if (!text) {
      // Claude returned nothing usable. Don't pollute the channel with
      // a "(no response)" placeholder — log it and stay silent. Clean up
      // the placeholder message and reactions if we created them.
      await log({ kind: "empty_response", key, inThread });
      if (placeholderTs) {
        try {
          await updateMessage(
            channel,
            placeholderTs,
            "_(no reply — see bridge logs)_",
          );
        } catch {}
      }
      if (reacted) {
        try {
          await removeReaction(channel, eventTs, "eyes");
        } catch {}
        try {
          await addReaction(channel, eventTs, "warning");
        } catch {}
      }
    } else {
      if (placeholderTs) {
        await updateMessage(channel, placeholderTs, text);
      } else {
        await postReply(channel, inThread ? threadTs : null, text);
      }
      await log({ kind: "replied", key, chars: text.length, inThread });

      if (reacted) {
        try {
          await removeReaction(channel, eventTs, "eyes");
        } catch {}
        try {
          await addReaction(channel, eventTs, "white_check_mark");
        } catch {}
      }
    }

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
      if (placeholderTs) {
        await updateMessage(
          channel,
          placeholderTs,
          `_(bridge error — check logs)_`,
        );
      } else {
        await postReply(
          channel,
          inThread ? threadTs : null,
          `_(bridge error — check logs)_`,
        );
      }
    } catch {}
    if (reacted) {
      try {
        await removeReaction(channel, eventTs, "eyes");
      } catch {}
      try {
        await addReaction(channel, eventTs, "warning");
      } catch {}
    }
  } finally {
    inFlight.delete(key);
  }
});

app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
  log({ kind: "boot", port: PORT });
});
