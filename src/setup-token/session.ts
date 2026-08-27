/**
 * Drives one `claude setup-token` login on a pseudo-terminal.
 *
 * Why a PTY: upstream characterized `setup-token` with pipe stdio and it
 * emitted **zero bytes** and hung until killed — the interactive login UI only
 * renders on a terminal. Rather than take a native `node-pty` dependency (which
 * would need a build toolchain in every host image), we borrow the PTY that
 * util-linux `script` already allocates. That keeps this plugin pure JavaScript
 * and installable from npm anywhere the Paperclip host runs.
 *
 * `script` here is the util-linux flavour (`-q -e -c`), which is what Linux
 * container images ship. The BSD/macOS `script` takes a different argument
 * order and is not supported.
 *
 * The raw stream carries a one-time secret. It is held in memory, never written
 * to disk, and only ever leaves this module through `redactForLogs`.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  checkCodeAgainstUrl,
  derivePhase,
  redactForLogs,
  type SetupTokenPhase,
} from "./parse.js";

/**
 * Environment passed to the child.
 *
 * The worker's own environment holds whatever the Paperclip runtime was given —
 * DATABASE_URL, provider keys, internal tokens. None of that is any business of
 * a login subprocess, so the child gets an allowlist rather than a copy.
 */
const INHERITED_ENV_KEYS = [
  "PATH",
  "TERM",
  "LANG",
  "LC_ALL",
  "TZ",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;

/**
 * Cap on retained PTY output.
 *
 * The stream is attacker-influenced in the sense that a misbehaving or replaced
 * executable controls its volume, and the buffer was previously unbounded and
 * fully re-parsed on every chunk. Head and tail are both kept: the head carries
 * the authorization URL, the tail carries the prompt and the success block.
 */
const MAX_HEAD_BYTES = 32 * 1024;
const MAX_TAIL_BYTES = 32 * 1024;

/** Bracketed paste markers — Claude's TUI turns this mode on (ESC[?2004h). */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

/** Default ceiling for a whole login. A human has to visit a browser in this window. */
export const DEFAULT_SESSION_TIMEOUT_MS = 10 * 60 * 1000;

/** Give up if Claude emits nothing at all for this long — it never reached the prompt. */
export const DEFAULT_STARTUP_TIMEOUT_MS = 60 * 1000;

/** Delay between delivering the paste and pressing Enter. */
const ENTER_DELAY_MS = 200;

/** If Claude has not reacted by now, press Enter once more. */
const ENTER_RETRY_MS = 8000;

/**
 * How long to wait for a submitted code to be accepted.
 *
 * A rejected code is answered with silence, not an error, so this bound is the
 * only thing that turns "wrong code" into a message instead of a hang.
 */
export const DEFAULT_CODE_ACCEPTANCE_TIMEOUT_MS = 90 * 1000;

export interface SetupTokenSessionOptions {
  /** Absolute path to the `claude` executable. */
  claudePath: string;
  /** `HOME` for the child, i.e. the Claude home the adapter reads. */
  home: string;
  /** Extra environment for the child. `HOME` is always overridden by `home`. */
  env?: Record<string, string>;
  /** Hosts the authorization URL may point at. */
  allowedHosts?: readonly string[];
  /** Path to `script`. Override only for tests. */
  scriptPath?: string;
  sessionTimeoutMs?: number;
  startupTimeoutMs?: number;
  codeAcceptanceTimeoutMs?: number;
  /** Called on every phase transition — never with raw terminal bytes. */
  onPhase?: (phase: SetupTokenPhase) => void;
}

export interface SetupTokenSession {
  /** The current phase. Safe to expose to a UI. */
  phase(): SetupTokenPhase;
  /** Send the code the browser handed back. Resolves once it has been written. */
  submitCode(code: string): Promise<void>;
  /** Resolves when the session reaches a terminal phase. */
  done(): Promise<SetupTokenPhase>;
  /** Terminate the child and settle as failed. Safe to call twice. */
  cancel(reason?: string): void;
  /** Redacted transcript, for diagnostics. Never contains the token or the PKCE query. */
  transcript(): string;
}

/**
 * `script -c` takes a shell string, so the executable path is interpolated into
 * a shell. Refuse anything that could break out of it rather than quoting and
 * hoping — this value comes from configuration, and configuration is editable.
 */
export function assertSafeExecutablePath(value: string): void {
  if (!value.startsWith("/")) {
    throw new Error("claudePath must be an absolute path");
  }
  if (!/^[A-Za-z0-9_@%+=:,.\/-]+$/.test(value)) {
    throw new Error("claudePath contains characters that are not safe to pass through a shell");
  }
}

/** The browser hands back an opaque code; reject anything that is not one. */
export function assertSafeCode(code: string): void {
  if (!/^[\x21-\x7e]{1,512}$/.test(code)) {
    throw new Error("The code must be a single line of printable characters.");
  }
}

export function startSetupTokenSession(
  options: SetupTokenSessionOptions,
): SetupTokenSession {
  const {
    claudePath,
    home,
    env = {},
    allowedHosts,
    scriptPath = "/usr/bin/script",
    sessionTimeoutMs = DEFAULT_SESSION_TIMEOUT_MS,
    startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
    codeAcceptanceTimeoutMs = DEFAULT_CODE_ACCEPTANCE_TIMEOUT_MS,
    onPhase,
  } = options;

  assertSafeExecutablePath(claudePath);
  assertSafeExecutablePath(scriptPath);

  let head = "";
  let tail = "";
  let truncated = false;
  /** The submitted code, retained solely so it can be redacted out again. */
  let submittedCode: string | null = null;

  const raw = () =>
    truncated ? `${head}\n[... output truncated ...]\n${tail}` : head + tail;

  const append = (chunk: string) => {
    if (head.length < MAX_HEAD_BYTES) {
      const room = MAX_HEAD_BYTES - head.length;
      head += chunk.slice(0, room);
      chunk = chunk.slice(room);
      if (!chunk) return;
    }
    tail += chunk;
    if (tail.length > MAX_TAIL_BYTES) {
      tail = tail.slice(tail.length - MAX_TAIL_BYTES);
      truncated = true;
    }
  };
  let phase: SetupTokenPhase = { kind: "starting" };
  let settled = false;
  let codeDeadline: ReturnType<typeof setTimeout> | null = null;
  let resolveDone: (phase: SetupTokenPhase) => void;
  const donePromise = new Promise<SetupTokenPhase>((resolve) => {
    resolveDone = resolve;
  });

  const childEnv: Record<string, string> = { HOME: home };
  for (const key of INHERITED_ENV_KEYS) {
    const value = process.env[key];
    if (typeof value === "string") childEnv[key] = value;
  }
  Object.assign(childEnv, env, { HOME: home });

  const child: ChildProcessWithoutNullStreams = spawn(
    scriptPath,
    ["-qec", `${claudePath} setup-token`, "/dev/null"],
    { env: childEnv, stdio: ["pipe", "pipe", "pipe"] },
  );

  const sessionTimer = setTimeout(
    () => settle({ kind: "failed", reason: "The sign-in timed out. Please start again." }),
    sessionTimeoutMs,
  );
  const startupTimer = setTimeout(() => {
    if (phase.kind === "starting") {
      settle({
        kind: "failed",
        reason: "Claude did not produce a sign-in link. Check that the Claude CLI is installed and runnable.",
      });
    }
  }, startupTimeoutMs);

  function settle(next: SetupTokenPhase): void {
    if (settled) return;
    settled = true;
    clearTimeout(sessionTimer);
    clearTimeout(startupTimer);
    if (codeDeadline) clearTimeout(codeDeadline);
    phase = next;
    onPhase?.(next);
    try {
      child.kill("SIGTERM");
      // A login sitting on its prompt ignores SIGTERM; escalate rather than leak
      // a process holding a half-finished OAuth exchange.
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 2000).unref?.();
    } catch {
      // Already gone.
    }
    resolveDone(next);
  }

  function ingest(chunk: Buffer): void {
    if (settled) return;
    append(chunk.toString("utf8"));
    const next = derivePhase(raw(), allowedHosts);
    if (next.kind === phase.kind && !isTerminal(next)) return;
    phase = next;
    onPhase?.(next);
    if (isTerminal(next)) settle(next);
  }

  child.stdout.on("data", ingest);
  child.stderr.on("data", ingest);

  child.on("error", (error) =>
    settle({ kind: "failed", reason: `Could not start the Claude CLI: ${error.message}` }),
  );

  child.on("exit", (code) => {
    if (settled) return;
    // A clean exit without the success marker still means no token.
    settle({
      kind: "failed",
      reason: `The Claude sign-in ended before a token was issued (exit code ${code ?? "unknown"}).`,
    });
  });

  return {
    phase: () => phase,
    // The code is masked by Claude today, but that is its behaviour, not our
    // guarantee — redact it ourselves so a future CLI that echoes it plainly
    // cannot leak it through polling or diagnostics.
    transcript: () => {
      const text = redactForLogs(raw());
      return submittedCode ? text.split(submittedCode).join("<REDACTED_CODE>") : text;
    },
    done: () => donePromise,
    cancel: (reason = "The sign-in was cancelled.") => settle({ kind: "failed", reason }),
    submitCode: (code: string) =>
      new Promise<void>((resolve, reject) => {
        if (settled) {
          reject(new Error("This sign-in is no longer active. Please start again."));
          return;
        }
        const current = phase;
        if (current.kind !== "awaiting_code" && current.kind !== "awaiting_authorization") {
          reject(new Error("This sign-in is not ready for a code yet."));
          return;
        }
        try {
          assertSafeCode(code);
        } catch (error) {
          reject(error);
          return;
        }
        // Claude gives no feedback at all on a bad code — it echoes the paste
        // masked and then sits silently on the prompt forever. So check the
        // code against the state this sign-in was issued with before spending
        // the user's time on it.
        const check = checkCodeAgainstUrl(code, current.authorizationUrl);
        if (!check.ok) {
          reject(new Error(check.reason));
          return;
        }
        // How a code has to be delivered, established by probing the real CLI:
        //
        //  - Enter is a CARRIAGE RETURN. Writing "\n" types the code but never
        //    submits it, so Claude waits in silence forever.
        //  - The CR must be a SEPARATE write. A code long enough to wrap onto a
        //    second line swallows a CR sent in the same chunk during the
        //    re-render — a 28-character code submitted fine, a 92-character one
        //    did nothing until a second Enter arrived.
        //  - Claude's TUI enables bracketed paste (ESC[?2004h), so the code is
        //    framed as a paste and handled atomically instead of as 92
        //    individual keystrokes.
        submittedCode = code.trim();
        const payload = `${PASTE_START}${submittedCode}${PASTE_END}`;
        child.stdin.write(payload, (error) => {
          if (error) {
            reject(error);
            return;
          }
          // Press Enter separately, once the paste has been absorbed.
          setTimeout(() => {
            if (!settled) child.stdin.write("\r");
          }, ENTER_DELAY_MS).unref?.();

          // Belt and braces: if nothing has moved, press Enter once more. A
          // second CR is what unstuck a wrapped paste in testing, and a
          // duplicate Enter on an already-submitted code is harmless.
          setTimeout(() => {
            if (!settled && phase.kind === "awaiting_code") child.stdin.write("\r");
          }, ENTER_RETRY_MS).unref?.();

          // Silence is the only signal a code was rejected server-side, so the
          // wait has to be bounded or the UI hangs forever.
          codeDeadline = setTimeout(
            () =>
              settle({
                kind: "failed",
                reason:
                  "Claude did not accept that code. Open the sign-in link again and copy the new code.",
              }),
            codeAcceptanceTimeoutMs,
          );
          resolve();
        });
      }),
  };
}

function isTerminal(phase: SetupTokenPhase): boolean {
  return phase.kind === "succeeded" || phase.kind === "failed";
}
