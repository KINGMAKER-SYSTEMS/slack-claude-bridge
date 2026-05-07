import { WebClient } from "@slack/web-api";

const token = process.env.SLACK_BOT_TOKEN;
export const slack = new WebClient(token || undefined);

function requireToken() {
  if (!token) throw new Error("SLACK_BOT_TOKEN not set");
}

export async function postReply(
  channel: string,
  threadTs: string,
  text: string,
) {
  requireToken();
  await slack.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text,
    mrkdwn: true,
  });
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
