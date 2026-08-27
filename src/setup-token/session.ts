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

/** Default ceiling for a whole login. A human has to visit a browser in this window. */
export const DEFAULT_SESSION_TIMEOUT_MS = 10 * 60 * 1000;

/** Give up if Claude emits nothing at all for this long — it never reached the prompt. */
export const DEFAULT_STARTUP_TIMEOUT_MS = 60 * 1000;

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

  let raw = "";
  let phase: SetupTokenPhase = { kind: "starting" };
  let settled = false;
  let codeDeadline: ReturnType<typeof setTimeout> | null = null;
  let resolveDone: (phase: SetupTokenPhase) => void;
  const donePromise = new Promise<SetupTokenPhase>((resolve) => {
    resolveDone = resolve;
  });

  const child: ChildProcessWithoutNullStreams = spawn(
    scriptPath,
    ["-qec", `${claudePath} setup-token`, "/dev/null"],
    {
      env: { ...process.env, ...env, HOME: home },
      stdio: ["pipe", "pipe", "pipe"],
    },
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
    raw += chunk.toString("utf8");
    const next = derivePhase(raw, allowedHosts);
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
    transcript: () => redactForLogs(raw),
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
        child.stdin.write(`${code.trim()}\n`, (error) => {
          if (error) {
            reject(error);
            return;
          }
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
