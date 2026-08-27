/**
 * Worker for the Claude sign-in plugin.
 *
 * It owns exactly one thing: the live `claude setup-token` pseudo-terminal.
 * It does not store the token. `setup-token` persists nothing itself, and the
 * adapter receives its credential as the `CLAUDE_CODE_OAUTH_TOKEN` env binding,
 * so the token is handed to the UI once and the UI writes it as a company
 * secret through the host's own API, as the signed-in human. See DESIGN.md.
 */

import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { ACTIONS } from "./manifest.js";
import { startSetupTokenSession, type SetupTokenSession } from "./setup-token/session.js";
import type { SetupTokenPhase } from "./setup-token/parse.js";

/** The env var the `claude_local` adapter reads. */
export const TOKEN_SECRET_KEY = "CLAUDE_CODE_OAUTH_TOKEN";

/**
 * What the UI is allowed to see. Deliberately not the phase itself: the
 * `succeeded` phase carries the token, and the token must reach the UI exactly
 * once, in the reply to the poll that observes success — never on every poll.
 */
export interface PublicStatus {
  state: "idle" | "starting" | "awaiting_authorization" | "awaiting_code" | "succeeded" | "failed";
  authorizationUrl?: string;
  reason?: string;
  /** Present exactly once, on the first poll that observes success. */
  token?: string;
  /** The key the UI should bind the token to. */
  secretKey?: string;
  /**
   * What Claude is showing, redacted.
   *
   * Safe to display: `redactForLogs` removes the token and every OAuth query
   * value, and the submitted code is masked by Claude itself. Sending it on
   * every poll is what turns an opaque wait into something a user can read —
   * and what makes a failure diagnosable without a console.
   */
  transcript?: string;
}

/** One live sign-in per company. A second start replaces the first. */
const sessions = new Map<string, { session: SetupTokenSession; tokenDelivered: boolean }>();

/**
 * The redacted transcript of the last finished sign-in, kept per company.
 *
 * A failed sign-in is otherwise undebuggable: the process is gone, the PTY
 * output went nowhere, and "Claude did not accept that code" is indistinguishable
 * from "we failed to recognise that Claude accepted it". The transcript is passed
 * through `redactForLogs`, so it carries neither the token nor the PKCE query.
 */
const lastTranscripts = new Map<string, { phase: string; transcript: string; at: string }>();

function remember(companyId: string, entry: { session: SetupTokenSession }, phase: SetupTokenPhase): void {
  lastTranscripts.set(companyId, {
    phase: phase.kind === "failed" ? `failed: ${phase.reason}` : phase.kind,
    transcript: entry.session.transcript(),
    at: new Date().toISOString(),
  });
}

function toPublic(phase: SetupTokenPhase): PublicStatus {
  switch (phase.kind) {
    case "starting":
      return { state: "starting" };
    case "awaiting_authorization":
      return { state: "awaiting_authorization", authorizationUrl: phase.authorizationUrl };
    case "awaiting_code":
      return { state: "awaiting_code", authorizationUrl: phase.authorizationUrl };
    case "succeeded":
      return { state: "succeeded", secretKey: TOKEN_SECRET_KEY };
    case "failed":
      return { state: "failed", reason: phase.reason };
  }
}

function requireCompanyId(input: unknown): string {
  const companyId = (input as { companyId?: unknown } | undefined)?.companyId;
  if (typeof companyId !== "string" || !companyId) {
    throw new Error("companyId is required.");
  }
  return companyId;
}

interface ResolvedConfig {
  claudePath: string;
  scriptPath: string;
  claudeHome: string;
}

const DEFAULTS: ResolvedConfig = {
  claudePath: "/usr/local/bin/claude",
  scriptPath: "/usr/bin/script",
  claudeHome: "",
};

let cachedConfig: ResolvedConfig | null = null;

/**
 * Resolve operator config lazily, inside a request.
 *
 * `ctx.config.get()` needs a company context and throws
 * "company context is required" during `setup()`, which fails worker
 * initialization outright. Every caller here is already company-scoped, so the
 * read happens on first use and is cached — the values come from
 * `instanceConfigSchema`, so they do not vary per company.
 *
 * A read failure falls back to defaults rather than breaking sign-in: an
 * unconfigured instance should still work on a stock container layout.
 */
async function resolveConfig(ctx: {
  config: { get(): Promise<Record<string, unknown>> };
  logger: { warn(message: string, meta?: unknown): void };
}): Promise<ResolvedConfig> {
  if (cachedConfig) return cachedConfig;

  let raw: Record<string, unknown> = {};
  try {
    raw = await ctx.config.get();
  } catch (error) {
    ctx.logger.warn("Falling back to default configuration", {
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  const pick = (key: keyof ResolvedConfig, fallback: string): string =>
    typeof raw[key] === "string" && (raw[key] as string).trim()
      ? (raw[key] as string).trim()
      : fallback;

  cachedConfig = {
    claudePath: pick("claudePath", DEFAULTS.claudePath),
    scriptPath: pick("scriptPath", DEFAULTS.scriptPath),
    claudeHome: pick(
      "claudeHome",
      process.env.PAPERCLIP_HOME || process.env.HOME || "/paperclip",
    ),
  };
  return cachedConfig;
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.actions.register(ACTIONS.start, async (input) => {
      const companyId = requireCompanyId(input);

      // Replace any earlier attempt rather than leaving a second PTY alive.
      sessions.get(companyId)?.session.cancel("Replaced by a new sign-in.");

      const { claudePath, scriptPath, claudeHome } = await resolveConfig(ctx);
      const session = startSetupTokenSession({
        claudePath,
        scriptPath,
        home: claudeHome,
        onPhase: (phase) => {
          if (phase.kind === "failed") {
            ctx.logger.warn("Claude sign-in failed", { companyId, reason: phase.reason });
          }
        },
      });
      sessions.set(companyId, { session, tokenDelivered: false });

      ctx.activity
        .log({ companyId, message: "Claude sign-in started." })
        .catch(() => undefined);

      return toPublic(session.phase());
    });

    ctx.actions.register(ACTIONS.poll, async (input) => {
      const companyId = requireCompanyId(input);
      const entry = sessions.get(companyId);
      if (!entry) return { state: "idle" } satisfies PublicStatus;

      const phase = entry.session.phase();
      const status: PublicStatus = {
        ...toPublic(phase),
        transcript: entry.session.transcript(),
      };

      // One-time delivery. After this reply the worker forgets the token, so a
      // replayed poll cannot hand it out again.
      if (phase.kind === "succeeded" && !entry.tokenDelivered) {
        entry.tokenDelivered = true;
        remember(companyId, entry, phase);
        sessions.delete(companyId);
        ctx.activity
          .log({ companyId, message: "Claude sign-in completed; token issued to the operator." })
          .catch(() => undefined);
        return { ...status, token: phase.token };
      }
      if (phase.kind === "succeeded" || phase.kind === "failed") {
        remember(companyId, entry, phase);
        sessions.delete(companyId);
      }
      return status;
    });

    ctx.actions.register(ACTIONS.submitCode, async (input) => {
      const companyId = requireCompanyId(input);
      const code = (input as { code?: unknown }).code;
      if (typeof code !== "string") throw new Error("A code is required.");

      const entry = sessions.get(companyId);
      if (!entry) throw new Error("There is no sign-in in progress. Start one first.");

      // Throws with a user-facing reason when the code belongs to another
      // sign-in — Claude itself says nothing at all about a bad code.
      await entry.session.submitCode(code);
      return toPublic(entry.session.phase());
    });

    ctx.actions.register(ACTIONS.cancel, async (input) => {
      const companyId = requireCompanyId(input);
      sessions.get(companyId)?.session.cancel();
      sessions.delete(companyId);
      return { state: "idle" } satisfies PublicStatus;
    });

    // Read the last finished sign-in's redacted transcript. This is the only
    // way to tell a rejected code from output we failed to parse.
    ctx.actions.register(ACTIONS.diagnostics, async (input) => {
      const companyId = requireCompanyId(input);
      return (
        lastTranscripts.get(companyId) ?? {
          phase: "none",
          transcript: "",
          at: "",
        }
      );
    });

    ctx.data.register(ACTIONS.status, async (input) => {
      const companyId = requireCompanyId(input);
      const entry = sessions.get(companyId);
      const { claudePath, claudeHome } = await resolveConfig(ctx);
      return {
        secretKey: TOKEN_SECRET_KEY,
        signInInProgress: Boolean(entry),
        claudePath,
        claudeHome,
      };
    });

    // Nothing company-scoped may be touched here: worker init has no company
    // context, and anything that needs one fails initialization outright.
    ctx.logger.info("Claude sign-in plugin ready");
  },

  async onShutdown() {
    for (const { session } of sessions.values()) session.cancel("The plugin is shutting down.");
    sessions.clear();
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
