# paperclip-claude-auth

A Paperclip plugin that lets a **non-technical person sign in to Claude from the Paperclip UI** — no terminal, no SSH, no pasted shell commands.

It drives `claude setup-token` on a pseudo-terminal in the background, shows the user a button and one input box, and binds the resulting **1-year** token as the `CLAUDE_CODE_OAUTH_TOKEN` secret the `claude_local` adapter reads.

Verified end to end on a self-hosted Paperclip instance: sign-in completes, the token is stored as a company secret, and Claude agents are connected to it.

```bash
# in the Paperclip Plugin Manager → Install Plugin
paperclip-claude-auth
```

Requires `@paperclipai/plugin-sdk` **2026.707.0 or newer** on the host, and a Linux runtime with util-linux `script` and the `claude` CLI available (both standard in the Paperclip container).

## Why this exists

Paperclip's own in-product Claude login (shipped upstream in `v2026.824.0`) is gated on the agent running in a **sandbox** environment whose provider advertises the login-PTY capability — today, only Daytona:

> The login affordance shows only when this environment is a sandbox, because the canonical auth-missing check comes only from a sandbox target.
> — `ui/src/components/AgentConfigForm.tsx`

Plenty of self-hosted instances run agents **locally**, because the agents need the host's files. Those instances get no login button at all, so when Claude auth lapses the only recovery is a human with shell access. This plugin closes that gap.

The failure it prevents is not hypothetical. On one instance a Claude OAuth **refresh token** expired ~46 days after login; the 6-hourly keepalive fired, the refresh was rejected, and Claude Code wrote back a credentials file with **empty tokens**. Every agent died instantly with `Authentication required`, `/api/health` still reported `ok`, and it went unnoticed for two days.

A `setup-token` credential is good for **a year** instead of ~46 days, and this plugin makes renewing it a two-click job for whoever owns the subscription.

## How it works

1. **Status** — reads the credential and shows *"Claude sign-in — valid until 27 Aug 2027"* or *"expired"*.
2. **Sign in** — the worker spawns `claude setup-token` on a PTY, parses the authorization URL out of the terminal stream, and the UI renders it as a button.
3. **Approve** — the user approves in their browser and pastes the code into a single field.
4. **Store** — the token is saved as the company secret `CLAUDE_CODE_OAUTH_TOKEN` (rotated in place if one already exists, keeping version history) and bound into the environment of every `claude_local` agent that does not already have one. `setup-token` persists nothing itself, so that binding is how agents actually receive it — see [DESIGN.md](DESIGN.md).
5. **Afterwards** — the panel reports the stored credential: when it was minted, when it expires, how many days remain, and a warning as expiry approaches. Signing in again renews it.

The user never sees terminal output. That is the point.

## Design notes

These were established by characterizing the real CLI, not by guessing.

**`setup-token` requires a PTY.** With pipe stdio it emits zero bytes and hangs until killed. Rather than depend on native `node-pty` — which would need a build toolchain in every host image — this plugin borrows the PTY that util-linux `script` already allocates:

```
script -qec "/usr/local/bin/claude setup-token" /dev/null
```

That keeps the plugin pure JavaScript and installable from npm anywhere the host runs. (util-linux `script` only; the BSD/macOS flavour takes different arguments.)

**The token is printed exactly once.** Claude says so itself — *"Store this token securely. You won't be able to see it again."* So the raw stream is held in memory, never written to disk, and only leaves the module through `redactForLogs()`, which strips the token and every OAuth query value. Redaction is per-parameter, not per-URL: the terminal hard-wraps the URL, so PKCE material appears on continuation lines with no scheme or host in front of it, and a whole-URL rule lets all of it through.

**A bad code is answered with silence.** No error, no re-prompt, no exit — the process just sits there. So the code is validated against the sign-in's `state` *before* submission, and the wait after submission is bounded. There is nothing to parse, so there is nothing to wait for.

**The authorization URL is validated before it becomes a button.** Only `https`, only an allow-listed host, only the `/cai/oauth/authorize` path. A URL we ask a user to click is a URL we have to vouch for.

**The parser degrades safely.** If Claude claims success but the token can't be read, the session fails loudly rather than binding whatever text happened to be there. A prose line is never mistaken for a credential.

**The shell interpolation is guarded.** `script -c` takes a shell string, so the configured `claude` path is checked against a strict allowlist rather than quoted and hoped for.

### Characterized against

| | |
|---|---|
| Claude Code | `2.1.205` (upstream fixtures, 2026-08-11 / 2026-08-12), re-observed on `2.1.245` |
| Authorization URL | `https://claude.com/cai/oauth/authorize` — `client_id`, `code`, `code_challenge`, `code_challenge_method`, `redirect_uri`, `response_type`, `scope`, `state` |
| Rendering | OSC 8 hyperlinks, ANSI CSI, spinner frames redrawn over CR, hard-wrapped URLs |
| Success marker | `✓ Long-lived authentication token created successfully!` |
| Token validity | 1 year, consumed as `CLAUDE_CODE_OAUTH_TOKEN` |

The terminal wraps the URL across display lines, so the parser reads the **OSC 8 hyperlink target** in preference to screen text — the hyperlink parameter always carries the whole URL on one line. Visible-text unwrapping exists only as a fallback.

## Development

```bash
npm install
npm test          # parser suite
npm run typecheck
npm run build
```

### Building inside a Paperclip runtime

Paperclip containers set `NODE_ENV=production`, so a plain `npm install` there
silently skips devDependencies and the build fails with
`Cannot find package 'esbuild'`. Use:

```bash
npm install --include=dev && npm run build
```

The source must also sit inside the host's bind mount to be visible from the
container — e.g. `<paperclip-data>/plugin-src/paperclip-claude-auth`, which
appears as `/paperclip/plugin-src/paperclip-claude-auth` inside it.

`@paperclipai/plugin-sdk` is a peer dependency. Development pins `2026.707.0` exactly — the version installed on both target instances — so accidental use of a newer API is a compile error. Newer hosts run it fine (Ordillect CT 201 is on the newest build and loads the Honcho plugin against this same SDK).

## Licence

MIT.
