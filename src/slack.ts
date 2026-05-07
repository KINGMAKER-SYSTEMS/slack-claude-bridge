import { WebClient } from "@slack/web-api";

const token = process.env.SLACK_BOT_TOKEN;
export const slack = new WebClient(token || undefined);

function requireToken() {
  if (!token) throw new Error("SLACK_BOT_TOKEN not set");
}

export async function postReply(
  channel: string,
  threadTs: string | null,
  text: string,
) {
  requireToken();
  const res = await slack.chat.postMessage({
    channel,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    text,
    mrkdwn: true,
  });
  return res.ts as string | undefined;
}

export async function updateMessage(
  channel: string,
  ts: string,
  text: string,
) {
  requireToken();
  await slack.chat.update({
    channel,
    ts,
    text,
  });
}

export async function addReaction(
  channel: string,
  ts: string,
  name: string,
) {
  requireToken();
  try {
    await slack.reactions.add({ channel, timestamp: ts, name });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("already_reacted")) throw err;
  }
}

export async function removeReaction(
  channel: string,
  ts: string,
  name: string,
) {
  requireToken();
  try {
    await slack.reactions.remove({ channel, timestamp: ts, name });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("no_reaction")) throw err;
  }
}

export async function fetchThread(channel: string, threadTs: string) {
  requireToken();
  const res = await slack.conversations.replies({
    channel,
    ts: threadTs,
    limit: 50,
  });
  return res.messages || [];
}

export async function fetchChannel(channel: string, limit = 100) {
  requireToken();
  const res = await slack.conversations.history({
    channel,
    limit,
  });
  return (res.messages || []).reverse();
}
