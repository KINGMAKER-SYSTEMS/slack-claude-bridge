# slack-claude-bridge

A local webhook server that turns @-mentions in Slack into headless [Claude Code](https://docs.claude.com/en/docs/claude-code) sessions on your laptop. Tag the bot in a Slack channel → `claude -p` spins up with full tool access (filesystem, git, gh, MCP servers) → the reply gets posted back as the bot.

Subsequent mentions in the same thread resume the same Claude session, so the conversation has memory.

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

- Real Claude Code, not stock chat. Same `CLAUDE.md`, same MCPs, same tool authority you have locally.
- Per-thread session continuity — each Slack thread maps to one Claude session ID, follow-ups resume it.
- Full channel context when tagged at the top level — pulls last 100 messages so the bot knows what's going on.
- Allowlisted users only. Anyone not on the list gets ignored silently.
- Slack signature verification on every request.
- Concurrency guard: one in-flight session per thread, late mentions get dropped (logged).
- Configurable system prompt (`prompts/system.md`) so each operator can shape their own bot's voice.
- JSON-line log at `data/bridge.log` for everything.

## What it can't do (yet)

- No off-machine availability. If the laptop sleeps, mentions sit in Slack until the laptop wakes and the tunnel reconnects. Future move: deploy the webhook to a cloud host and have it tunnel into the local machine.
- No streaming replies. The bot waits until Claude finishes and posts one message. Long answers feel slow.
- No cost cap. Every mention is a fresh Claude billable session. The allowlist is the only governor.
- Limited bot-loop detection beyond the `bot_id` field — be careful in channels with other auto-responders.

## Quick start

```bash
git clone https://github.com/KINGMAKER-SYSTEMS/slack-claude-bridge.git
cd slack-claude-bridge
pnpm setup
```

The setup script walks you through:
1. Dependency check (`node 22+`, `pnpm`, `cloudflared`, `claude`)
2. `pnpm install`
3. Generating `.env` interactively (Slack secrets, allowlist)
4. Generating `cloudflared.yml` for your named tunnel
5. Copying the example system prompt
6. Printing next steps for the Slack app + tunnel

Most of it is fill-in-the-blank. The two manual pieces are creating the Slack app (browser) and setting up the Cloudflare tunnel (one CLI command, one DNS record). Both are detailed below.

## Files

```
src/
  server.ts                 Fastify webhook, signature verify, dispatch
  spawn.ts                  `claude -p` runner, parses stream-json, extracts session_id
  slack.ts                  Slack Web API client (postReply, fetchThread, fetchChannel)
  sessions.ts               thread_ts ↔ session_id map, persisted at data/sessions.json
  verify.ts                 HMAC SHA256 signature check
  log.ts                    JSON-line logger to stdout + data/bridge.log
prompts/
  system.example.md         default system prompt template (committed)
  system.md                 your operator-specific system prompt (gitignored)
slack-app-manifest.yaml     one-click Slack app config (paste into api.slack.com/apps)
cloudflared.example.yml     tunnel config template
scripts/
  setup.sh                  interactive first-run setup (`pnpm setup`)
  install-launchd.sh        install autostart plist for the bridge
  uninstall-launchd.sh
```

## Manual setup (if you skip `pnpm setup`)

### 1. Slack app

1. Go to https://api.slack.com/apps → **Create New App** → **From an app manifest**.
2. Pick your workspace.
3. Paste the contents of `slack-app-manifest.yaml`. The editor defaults to JSON — toggle YAML before pasting.
4. Edit `display_information.name`, `bot_user.display_name`, and `event_subscriptions.request_url` to match your bot and tunnel hostname before saving.
5. **Save Changes**. Slack will hit your URL with a verification challenge — this fails until the bridge is running and the tunnel is up. Come back to install after step 3 of this section.
6. **Install App → Install to Workspace** and approve permissions.
7. Grab three things and put them in `.env`:
   - **Signing Secret** — Settings → Basic Information → "App Credentials"
   - **Bot User OAuth Token** (`xoxb-...`) — OAuth & Permissions
   - **Bot User ID** — `curl -s "https://slack.com/api/auth.test" -H "Authorization: Bearer xoxb-..."` and grab `user_id`

### 2. Cloudflare tunnel (persistent public URL)

You need a stable hostname so Slack's webhook config doesn't break every reboot. The throwaway `pnpm tunnel` script is fine for testing but generates a new URL each run.

For a persistent named tunnel:

```bash
# 1. Create the tunnel (one-time)
cloudflared tunnel create <tunnel-name>
# → writes credentials to ~/.cloudflared/<tunnel-id>.json
# → prints the tunnel ID — note it

# 2. Route DNS to the tunnel (one-time, requires a domain on your Cloudflare account)
cloudflared tunnel route dns <tunnel-id> <hostname>

# 3. Copy template and fill in
cp cloudflared.example.yml cloudflared.yml
# Edit cloudflared.yml: tunnel ID, credentials path, hostname
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
# In another terminal:
curl https://<your-hostname>/health
# Expect {"ok":true} once the bridge is also running
```

### 3. Run the bridge

```bash
pnpm dev
```

Then go back to Slack → Event Subscriptions and click **Save Changes** again. The URL verification should now succeed.

Invite the bot to a channel (`/invite @<bot-name>`), tag it. You should see logs in stdout and a reply within ~5–30s.

## Autostart on login

Two pieces both need to autostart for the bridge to work after a reboot.

### Bridge server

```bash
./scripts/install-launchd.sh
```

Installs `~/Library/LaunchAgents/com.slack-claude-bridge.plist`. Override the label with `BRIDGE_PLIST_NAME=com.you.my-bot ./scripts/install-launchd.sh` if you run multiple bots. Uninstall with `./scripts/uninstall-launchd.sh`.

### Cloudflare tunnel

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

Verify with `launchctl print system/com.cloudflare.cloudflared` (state should be `running`) and `cloudflared tunnel info <tunnel-id>` (should show 4 active connections to Cloudflare's edge).

Logs:

```bash
tail -f /Library/Logs/com.cloudflare.cloudflared.err.log
```

## Customizing the bot's voice

The system prompt that Claude runs with lives in `prompts/system.md` (gitignored). Default starting point is `prompts/system.example.md`. Edit `system.md` to set your bot's tone, behavior rules, and what it knows about your team.

Override the path with `SYSTEM_PROMPT_FILE=/some/other/path.md` in `.env` if you want.

## How thread sessions work

When a mention arrives:

1. `threadKey = channel:thread_ts`
2. Look up `data/sessions.json` for an existing Claude `session_id` for that key.
3. Spawn `claude -p` with `--resume <session_id>` if found, else fresh.
4. Stream JSON output, capture the new `session_id` from the first event.
5. Save `{key: {sessionId, updatedAt}}` back to `sessions.json`.

This means if a teammate mentions the bot in a thread on Tuesday, then someone else pings it Wednesday, Claude resumes with full thread memory.

### Channel context vs thread context

- **Mentioned at the top level of a channel** (not inside a thread): the bridge calls `conversations.history` and prepends the last 100 channel messages.
- **Mentioned inside an existing thread**: the bridge calls `conversations.replies` and uses just the thread.

This way the bot knows what's going on in a busy channel without you having to manually summarize it.

## Security model

- **Slack signature verification** — every POST is HMAC'd against `SLACK_SIGNING_SECRET`. Missing/expired/wrong signature = 401.
- **User allowlist** — `ALLOWED_USER_IDS` env var. Mentions from anyone not on the list are dropped silently.
- **Bot self-ignore** — events where `event.user === SLACK_BOT_USER_ID` or `event.bot_id` is set are ignored, prevents the bot replying to itself or other bots.
- **Local tool authority** — Claude has the same tool authority you have locally. **Anyone in `ALLOWED_USER_IDS` is effectively granted that authority through this bridge.** Treat the allowlist as a list of people you trust to type into your terminal.

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

1. Check `data/bridge.log` — if there's no entry, Slack isn't reaching the bridge. Confirm Event Subscriptions URL matches the tunnel hostname.
2. Check that your Slack user ID is in `ALLOWED_USER_IDS`. Mismatches log as `blocked_user`.
3. Make sure the bot is invited to the channel (`/invite @<bot-name>`).
4. If you see `replied` events but nothing in Slack, check whether replies are landing as thread replies on the message that mentioned the bot.

**Tunnel disconnects after sleep.**
The systemwide cloudflared service should auto-reconnect. Verify with `launchctl print system/com.cloudflare.cloudflared` — `state = running` means alive. If not, `sudo launchctl kickstart -k system/com.cloudflare.cloudflared`.

**`tsx watch` doesn't pick up `.env` changes.**
It only restarts on `.ts` file changes. Manually restart:
```bash
lsof -ti:3737 | xargs kill -9 && pnpm dev
```

## Multi-operator setup

If multiple teammates each run their own bot:

- Each clones this repo independently
- Each creates their own Slack app (different display name, e.g. `johns-claude`, `erics-claude`)
- Each gets their own Cloudflare tunnel and hostname
- Each maintains their own `prompts/system.md` to shape their bot's behavior
- The allowlist (`ALLOWED_USER_IDS`) typically includes the same team in everyone's `.env`

The shared parts of the SOP — skills files, conduct docs, agent playbooks — can live in a `docs/` directory in this repo and get pulled with `git pull`. PRs from teammates update the shared playbook.

## Known issues / TODO

- [ ] If `claude -p` hangs (rare, but happens), the in-flight guard never clears. Add a hard timeout (10 min default).
- [ ] No streaming partial replies to Slack. Could `chat.update` an initial "thinking…" message as text accumulates.
- [ ] `fetchThread`/`fetchChannel` are capped at 50/100 messages — long threads/channels get truncated.
- [ ] Bot will respond to `message_changed` events if structured as edit-with-mention. Currently filtered by checking subtype.
- [ ] No retry on transient Slack API failures (`postReply` swallows the error and logs).

## License

MIT
