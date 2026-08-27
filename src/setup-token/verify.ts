/**
 * Prove a freshly minted token actually works, before anyone stores it.
 *
 * This exists because a malformed credential passed every other check we had.
 * A token truncated at the terminal's 80-column wrap still looked like a
 * token, was accepted by the UI, was written to the secret store, was bound to
 * eight agents — and only failed at the point of use, with
 * `401 OAuth access token is invalid`, two layers away from its cause.
 *
 * Note that `claude auth status` is **not** sufficient: it reports
 * `{"loggedIn": true, "authMethod": "oauth_token"}` for a deliberately bogus
 * token, because it only checks that a token is present. Verified on 2.1.245.
 * Only a real API round trip distinguishes a good credential from a plausible
 * one, so that is what this does — one minimal prompt, once per sign-in.
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A round trip plus model latency; generous, because failing open is worse. */
export const DEFAULT_VERIFY_TIMEOUT_MS = 90_000;

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Interpret `claude -p ... --output-format json` output.
 *
 * Pure, so the interpretation is testable without spending an API call.
 * Anything unrecognised fails closed: storing a credential we could not
 * confirm is the exact mistake this module exists to prevent.
 */
export function interpretAuthProbe(stdout: string): VerifyResult {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return { ok: false, reason: "Claude produced no response when the new token was tested." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: "Claude's response to the token test could not be read." };
  }

  const result = parsed as { is_error?: unknown; result?: unknown };
  if (result.is_error === false) return { ok: true };

  if (result.is_error === true) {
    const detail = typeof result.result === "string" ? result.result.trim() : "";
    return {
      ok: false,
      reason: detail
        ? `The new token was rejected by Claude: ${detail}`
        : "The new token was rejected by Claude.",
    };
  }

  return { ok: false, reason: "Claude's response to the token test was not recognised." };
}

export interface VerifyTokenOptions {
  claudePath: string;
  token: string;
  timeoutMs?: number;
}

/**
 * Run one prompt as the new token and report whether it authenticated.
 *
 * Deliberately uses a throwaway HOME. With the real home the CLI could
 * authenticate from an existing credential file and report success for a token
 * that is worthless — a false green in precisely the situation this guards.
 */
export async function verifyToken(options: VerifyTokenOptions): Promise<VerifyResult> {
  const { claudePath, token, timeoutMs = DEFAULT_VERIFY_TIMEOUT_MS } = options;

  let home: string | null = null;
  try {
    home = await mkdtemp(join(tmpdir(), "claude-auth-verify-"));
    const isolatedHome = home;

    return await new Promise<VerifyResult>((resolve) => {
      execFile(
        claudePath,
        ["-p", "hi", "--output-format", "json"],
        {
          env: {
            PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
            HOME: isolatedHome,
            CLAUDE_CODE_OAUTH_TOKEN: token,
            ...(process.env.NODE_EXTRA_CA_CERTS
              ? { NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS }
              : {}),
            ...(process.env.HTTPS_PROXY ? { HTTPS_PROXY: process.env.HTTPS_PROXY } : {}),
          },
          timeout: timeoutMs,
          maxBuffer: 2 * 1024 * 1024,
        },
        (error, stdout) => {
          // A non-zero exit still prints the JSON verdict, so read stdout
          // first and only fall back to the process error.
          const verdict = interpretAuthProbe(stdout ?? "");
          if (verdict.ok) {
            resolve(verdict);
            return;
          }
          if (error && !stdout?.trim()) {
            resolve({
              ok: false,
              reason: `The new token could not be tested: ${error.message}`,
            });
            return;
          }
          resolve(verdict);
        },
      );
    });
  } catch (error) {
    return {
      ok: false,
      reason: `The new token could not be tested: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  } finally {
    if (home) await rm(home, { recursive: true, force: true }).catch(() => undefined);
  }
}
