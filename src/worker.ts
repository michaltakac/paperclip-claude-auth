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
}

/** One live sign-in per company. A second start replaces the first. */
const sessions = new Map<string, { session: SetupTokenSession; tokenDelivered: boolean }>();

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

const plugin = definePlugin({
  async setup(ctx) {
    const config = await ctx.config.get();
    const claudePath =
      typeof config.claudePath === "string" && config.claudePath
        ? config.claudePath
        : "/usr/local/bin/claude";
    const scriptPath =
      typeof config.scriptPath === "string" && config.scriptPath
        ? config.scriptPath
        : "/usr/bin/script";
    const claudeHome =
      typeof config.claudeHome === "string" && config.claudeHome
        ? config.claudeHome
        : process.env.PAPERCLIP_HOME || process.env.HOME || "/paperclip";

    ctx.actions.register(ACTIONS.start, async (input) => {
      const companyId = requireCompanyId(input);

      // Replace any earlier attempt rather than leaving a second PTY alive.
      sessions.get(companyId)?.session.cancel("Replaced by a new sign-in.");

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
      const status = toPublic(phase);

      // One-time delivery. After this reply the worker forgets the token, so a
      // replayed poll cannot hand it out again.
      if (phase.kind === "succeeded" && !entry.tokenDelivered) {
        entry.tokenDelivered = true;
        sessions.delete(companyId);
        ctx.activity
          .log({ companyId, message: "Claude sign-in completed; token issued to the operator." })
          .catch(() => undefined);
        return { ...status, token: phase.token };
      }
      if (phase.kind === "succeeded" || phase.kind === "failed") {
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

    ctx.data.register(ACTIONS.status, async (input) => {
      const companyId = requireCompanyId(input);
      const entry = sessions.get(companyId);
      return {
        secretKey: TOKEN_SECRET_KEY,
        signInInProgress: Boolean(entry),
        claudePath,
        claudeHome,
      };
    });

    ctx.logger.info("Claude sign-in plugin ready", { claudePath, claudeHome });
  },

  async onShutdown() {
    for (const { session } of sessions.values()) session.cancel("The plugin is shutting down.");
    sessions.clear();
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
