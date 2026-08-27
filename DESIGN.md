# Design

Everything here was established by reading upstream Paperclip and characterizing the real Claude CLI, not by inference. Where something is still unverified it says so.

## The problem

Paperclip's in-product Claude login (upstream `v2026.824.0`) never appears on an instance that runs agents **locally**. It is gated on a sandbox environment whose provider advertises the login-PTY capability, and only Daytona implements that. So on a local instance, when Claude auth lapses, every agent dies and the only recovery is a human with shell access.

## How the token actually reaches the adapter

This was the decisive question, and the answer is not what it first looks like.

`claude setup-token` **does not persist anything**. Its closing lines are:

```
Store this token securely. You won't be able to see it again.
Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>
```

Confirmed on a live instance (Ordillect CT 201, which already runs this pattern): `CLAUDE_CODE_OAUTH_TOKEN` is set in the container environment and there is **no `.credentials.json` on disk at all**, yet `claude auth status` reports `{"loggedIn": true, "authMethod": "oauth_token"}`.

A plugin worker cannot change the environment of the host's adapter child processes, so the token has to reach the adapter the way the host already supports: as a **secret bound to an env var**.

Upstream converged on exactly this. Its own login flow binds `CLAUDE_CODE_OAUTH_TOKEN` as a user secret — visible in `AgentConfigForm.tsx`:

> After a login binds `CLAUDE_CODE_OAUTH_TOKEN`, the user-secret-definitions list […] The bound row then compares […]

and the API to do it exists on every instance that has the secrets stack:

```
POST   /api/companies/:companyId/user-secret-definitions
PATCH  /api/companies/:companyId/user-secret-definitions/:definitionId
GET    /api/companies/:companyId/user-secret-definitions
```

## Architecture

```
┌── plugin UI (same-origin, board session) ──┐
│  status card · sign-in modal · code field   │
└───────┬──────────────────────────▲──────────┘
   actions.performAction      one-time token
        ▼                          │
┌── plugin worker (plain node child process) ─┐
│  script -qec "claude setup-token" /dev/null │
│  parse.ts → phase   session.ts → lifecycle  │
└─────────────────────────────────────────────┘
                                   │
                    UI writes the secret via the host's
                    own user-secret-definitions API, then
                    the agent binds it as an env var.
```

**Why the UI stores the secret, not the worker.** `PluginSecretsClient` is read-only — `resolve()` only — and `PluginAgentsClient` has no config write (`list`/`get`/`pause`/`resume`/`invoke`). But plugin UI bundles run same-origin inside the Paperclip app and can call ordinary Paperclip HTTP APIs with the board session. So the write happens as the signed-in human, through supported endpoints, under that human's own permissions. That is a better authorization story than a worker holding write capability, and it matches what upstream does — so this slots in cleanly if it is contributed upstream.

**Verified:** plugin workers are plain Node child processes (`node .../paperclip-honcho/dist/worker-bootstrap.js`), with no sandbox, so `child_process` and the `script` PTY are available from inside a worker.

## Why `script` and not `node-pty`

`setup-token` requires a terminal — with pipe stdio it emits **zero bytes** and hangs until killed. `node-pty` is a native module, which would mean a build toolchain in every host image and would make this uninstallable on a stock Paperclip container. util-linux `script` already allocates a PTY:

```
script -qec "/usr/local/bin/claude setup-token" /dev/null
```

That keeps the plugin pure JavaScript and npm-installable. (util-linux only — the BSD/macOS `script` takes different arguments.)

Because `script -c` takes a **shell string**, the configured executable path is validated against a strict allowlist rather than quoted and hoped for. It comes from configuration, and configuration is editable.

## Handling the secret

The token is printed exactly once and cannot be retrieved again, so:

- the raw PTY stream is held in memory, never written to disk;
- it leaves the module only through `redactForLogs()`, which strips the token **and** the authorization URL's query (that query carries the PKCE `code_challenge` and `state`);
- the authorization URL is validated — https, allow-listed host, `/cai/oauth/authorize` — before the UI renders it as a clickable button;
- a success claim with an unreadable token fails loudly rather than binding whatever text was there.

## Still open

- **Where the binding lands by default.** Company-scoped secret vs per-agent binding, and what the plugin should do when a definition for `CLAUDE_CODE_OAUTH_TOKEN` already exists (update in place is the obvious answer; needs confirming against the PATCH contract).
- **The invalid-code retry path.** Upstream's fixture mentions it but does not record its text. The parser currently treats a re-appearing prompt as "still awaiting code"; that should be characterized properly so the UI can say "that code was rejected".
- **Host version floor.** Development pins `@paperclipai/plugin-sdk@^2026.824.1`. Older hosts expose an older context surface — MHA's instance is on a July build and would need an upgrade, or a compatibility pass, before this installs there.
