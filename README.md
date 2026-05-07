# slack-claude-bridge

A local webhook server that turns @-mentions in Slack into headless Claude Code sessions on John's Mac.

Tag the bot in a Slack channel → `claude -p` spins up with full tool access (filesystem, git, gh, brain CLI, the campaign hub repo, Slack MCP) → the reply gets posted back as the bot. Subsequent mentions in the same thread resume the same Claude session, so the conversation has memory.

```
Slack mention
   ↓
Slack Events API (HTTPS)
   ↓
Cloudflare Tunnel  ──→  localhost:3737  (this server)
                              ↓
                        spawn `claude -p --resume <session>`
                              ↓
                        post reply via Slack Web API
```

## What you get

- Real Claude Code, not stock chat. Same CLAUDE.md, same MCPs, same tool authority John has.
- Per-thread session continuity — each Slack thread maps to one Claude session ID, follow-ups resume it.
- Full channel context when tagged at the top level — pulls last 100 messages so the bot knows what's going on.
- Allowlisted users only. Anyone not on the list gets ignored silently.
- Slack signature verification on every request.
- Concurrency guard: one in-flight session per thread, late mentions get dropped (logged).
- JSON line log at `data/bridge.log` for everything.

## What it can't do (yet)

- No off-Mac availability. If the laptop sleeps, mentions sit in Slack until the laptop wakes and the tunnel reconnects. Future move: deploy the webhook to Railway and have it SSH/Tailscale into the Mac to spawn sessions.
- No streaming replies. The bot waits until Claude finishes and posts one message. Long answers feel slow.
- No cost cap. Every mention is a fresh Claude billable session. The allowlist is the only governor right now.
- No "do not respond if previous message was from another bot" detection beyond the bot_id field — be careful about putting this in a channel with another auto-responder.

## Files

```
src/
  server.ts     Fastify webhook, signature verify, dispatch
  spawn.ts      `claude -p` runner, parses stream-json, extracts session_id
  slack.ts      Slack Web API client (postReply, fetchThread, fetchChannel)
  sessions.ts   thread_ts ↔ session_id map, persisted at data/sessions.json
  verify.ts     HMAC SHA256 signature check
  log.ts        JSON-line logger to stdout + data/bridge.log
slack-app-manifest.yaml   one-click Slack app config
cloudflared.yml           tunnel config (points at localhost:3737)
scripts/
  install-launchd.sh    install autostart plist for the bridge
  uninstall-launchd.sh
```

## Setup (first time, ~20 min)

### 1. Slack app

1. Go to https://api.slack.com/apps → **Create New App** → **From an app manifest**.
2. Pick your workspace.
3. Paste the contents of `slack-app-manifest.yaml` (use the YAML toggle in the editor; Slack defaults to JSON).
4. Update `request_url` in the manifest to your tunnel hostname before saving.
5. Save Changes — Slack will hit the URL once with a `url_verification` challenge. The bridge has to be running and reachable for this to succeed (see steps 3–5 below; come back to install after).
6. **Install App → Install to Workspace**.
7. Grab three things:
   - **Signing Secret** → Settings → Basic Information → "App Credentials"
   - **Bot User OAuth Token** (`xoxb-…`) → OAuth & Permissions
   - **Bot User ID** → run `curl -s "https://slack.com/api/auth.test" -H "Authorization: Bearer xoxb-…"` and grab `user_id`

### 2. Local config

```bash
cd ~/dev/slack-claude-bridge
cp .env.example .env
# edit .env with the three values above
# ALLOWED_USER_IDS already has John (U0AE6PZQ0F4) — add teammates by Slack user ID
pnpm install
mkdir -p data
```

### 3. Cloudflare Tunnel (public URL for Slack to reach you)

You need a stable hostname so Slack's webhook config doesn't break every time the laptop reboots. The throwaway `pnpm tunnel` script is fine for testing but generates a new URL each run.

For a persistent named tunnel:

```bash
# 1. Create the tunnel (one-time)
cloudflared tunnel create <tunnel-name>
# → writes credentials to ~/.cloudflared/<tunnel-id>.json
# → prints the tunnel ID — note it

# 2. Route DNS to the tunnel (one-time, requires a domain on your Cloudflare account)
cloudflared tunnel route dns <tunnel-id> <hostname>
# example: cloudflared tunnel route dns 1937648d-... smaths-bot.agentsworld.org

# 3. Update cloudflared.yml in this repo with your tunnel ID and credentials path
```

`cloudflared.yml` should look like:

```yaml
tunnel: <your-tunnel-id>
credentials-file: /Users/<you>/.cloudflared/<your-tunnel-id>.json

ingress:
  - hostname: <your-hostname>
    service: http://127.0.0.1:3737
  - service: http_status:404
```

Test the tunnel:

```bash
cloudflared tunnel --config ./cloudflared.yml run
# In another terminal: curl https://<your-hostname>/health
# Expect {"ok":true} once the bridge is also running
```

### 4. Point Slack at the tunnel

Back in the Slack app config:
- **Event Subscriptions** → Request URL → `https://<your-hostname>/slack/events`
- Slack will hit it once with a `url_verification` challenge — the server handles it automatically.
- Save. If it fails verification, the bridge isn't running or the tunnel isn't reachable.

### 5. Run the bridge

```bash
pnpm dev
```

Invite the bot to a channel (`/invite @<bot-name>`), tag it. You should see logs in stdout and a reply within ~5–30s.

## Autostart on login (optional)

Two pieces both need to autostart for the bridge to work after a reboot:

### The bridge server

```bash
./scripts/install-launchd.sh
```

This installs `~/Library/LaunchAgents/com.risingtides.slack-claude-bridge.plist` and starts it. Uninstall with `./scripts/uninstall-launchd.sh`.

### The Cloudflare tunnel

```bash
sudo cloudflared --config /absolute/path/to/cloudflared.yml service install
```

This installs cloudflared as a system-wide launchd daemon. **Heads up:** the macOS service installer writes a plist that ignores the `--config` flag. Edit `/Library/LaunchDaemons/com.cloudflare.cloudflared.plist` so `ProgramArguments` includes the config explicitly:

```xml
<array>
    <string>/opt/homebrew/bin/cloudflared</string>
    <string>--config</string>
    <string>/absolute/path/to/cloudflared.yml</string>
    <string>tunnel</string>
    <string>run</string>
    <string><your-tunnel-id></string>
</array>
```

Then:

```bash
sudo launchctl bootout system/com.cloudflare.cloudflared 2>/dev/null
sudo launchctl bootstrap system /Library/LaunchDaemons/com.cloudflare.cloudflared.plist
```

Verify with `launchctl print system/com.cloudflare.cloudflared` and `cloudflared tunnel info <tunnel-id>` (should show 4 active connections to Cloudflare's edge).

Logs:

```bash
tail -f /Library/Logs/com.cloudflare.cloudflared.err.log
```

## How thread sessions work

When a mention arrives:

1. `threadKey = channel:thread_ts`
2. Look up `sessions.json` for an existing Claude `session_id` for that key.
3. Spawn `claude -p` with `--resume <session_id>` if found, else fresh.
4. Stream JSON output, capture the new session_id from the first event.
5. Save `{key: {sessionId, updatedAt}}` back to `sessions.json`.

This means if a teammate mentions the bot in a thread on Tuesday, then John pings it again Wednesday, Claude resumes with full thread memory. The Slack thread itself is also fetched on every call (`conversations.replies`) and prepended as context, so even a stale session sees the latest messages.

### Channel context vs thread context

- **Mentioned at the top level of a channel** (not inside a thread): the bridge calls `conversations.history` and prepends the last 100 channel messages as context.
- **Mentioned inside an existing thread**: the bridge calls `conversations.replies` and uses just the thread.

This way the bot knows what's going on in a busy channel without you having to manually summarize it.

## Security model

- **Slack signature verification** — every POST is HMAC'd against `SLACK_SIGNING_SECRET`. Missing/expired/wrong signature = 401.
- **User allowlist** — `ALLOWED_USER_IDS` env var. Mentions from anyone not on the list are dropped silently. Default has only John.
- **Bot self-ignore** — events where `event.user === SLACK_BOT_USER_ID` or `event.bot_id` is set are ignored, prevents the bot from replying to its own messages.
- **No write access on shared infra** — Claude has the same tool authority John has locally. Be conscious that anyone in `ALLOWED_USER_IDS` is effectively granted that authority through this bridge.

## Operations

```bash
# tail the log (live)
tail -f data/bridge.log | jq

# inspect sessions
cat data/sessions.json | jq

# nuke a stuck thread session (forces a fresh claude session next mention)
jq 'del(."C123:1234567890.000000")' data/sessions.json > /tmp/s.json && mv /tmp/s.json data/sessions.json

# check tunnel status
cloudflared tunnel info <tunnel-id>

# restart the bridge if you've edited .env (tsx watch only restarts on .ts changes)
lsof -ti:3737 | xargs kill -9 && pnpm dev
```

## Troubleshooting

**Slack URL verification fails when saving event subscriptions.**
Bridge isn't running, tunnel isn't connected, or hostname isn't routing. Check in order:

1. `curl http://localhost:3737/health` — should return `{"ok":true}`. If not, the bridge is dead.
2. `curl https://<your-hostname>/health` — should return the same. If you get a 502, the tunnel is up but the bridge isn't. If you get DNS errors, the route hasn't propagated yet (give it 30s).
3. `cloudflared tunnel info <tunnel-id>` — should show active connections.

**Bot doesn't respond to mentions.**

1. Check `data/bridge.log` — if there's no entry, Slack isn't reaching the bridge. Confirm the Event Subscriptions URL matches the tunnel hostname.
2. Check that your Slack user ID is in `ALLOWED_USER_IDS`. Mismatches log as `blocked_user`.
3. Make sure the bot is invited to the channel (`/invite @<bot-name>`).
4. If you see `replied` events but nothing in Slack, check whether replies are landing as thread replies on the message that mentioned the bot.

**Tunnel disconnects after sleep.**
The systemwide cloudflared service should auto-reconnect. Verify with `launchctl print system/com.cloudflare.cloudflared` — `state = running` means it's alive. If not, `sudo launchctl kickstart -k system/com.cloudflare.cloudflared`.

**`tsx watch` doesn't pick up `.env` changes.**
It only restarts on `.ts` file changes. Manually restart:
```bash
lsof -ti:3737 | xargs kill -9 && pnpm dev
```

## When to stop using this and build the next thing

- If the bot gets used >50 times/day, build a per-user budget and rate limit.
- If someone non-allowlisted mentions it constantly, add explicit ignore-and-reply-once-with-redirect.
- If you want it available when the Mac is asleep, build the Railway-relays-to-Mac-via-Tailscale version.
- If a teammate wants their own bot with their own context, fork this and change `ALLOWED_USER_IDS` + `SYSTEM_PROMPT` in `src/spawn.ts`.

## Known issues / TODO

- [ ] If `claude -p` hangs (rare, but happens), the in-flight guard never clears. Add a hard timeout (10 min default).
- [ ] No streaming partial replies to Slack. Could `chat.update` an initial "thinking…" message as text accumulates.
- [ ] `fetchThread`/`fetchChannel` are capped at 50/100 messages — long threads/channels get truncated.
- [ ] Bot will respond to message_changed events if structured as edit-with-mention. Currently filtered by checking subtype.
- [ ] No retry on transient Slack API failures (`postReply` swallows the error and logs).
