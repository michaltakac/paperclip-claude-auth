import { beforeEach, describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { ABANDONED_AFTER_MS, createClaudeAuthPlugin } from "../src/worker.js";
import type { SetupTokenPhase } from "../src/setup-token/parse.js";
import type { SetupTokenSession } from "../src/setup-token/session.js";

/**
 * The ownership model is the security-critical part of this plugin: whoever
 * polls first receives a one-year credential. It was previously verified only
 * by reading the code, which is not verification.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const ALICE = "22222222-2222-4222-8222-222222222222";
const BOB = "33333333-3333-4333-8333-333333333333";
const AUTH_URL = "https://claude.com/cai/oauth/authorize?state=s1";
const TOKEN = "sk-ant-oat01-TESTTOKENVALUE0123456789";

/** A session whose phase the test drives directly. */
function fakeSession(initial: SetupTokenPhase = { kind: "awaiting_code", authorizationUrl: AUTH_URL }) {
  let phase = initial;
  const submitted: string[] = [];
  let cancelledWith: string | null = null;
  const session: SetupTokenSession = {
    phase: () => phase,
    transcript: () => "Paste code here if prompted >\n****",
    done: () => new Promise(() => {}),
    cancel: (reason = "cancelled") => {
      cancelledWith = reason;
      phase = { kind: "failed", reason };
    },
    submitCode: async (code: string) => {
      submitted.push(code);
    },
  };
  return {
    session,
    submitted,
    get cancelled() {
      return cancelledWith;
    },
    succeed: () => {
      phase = { kind: "succeeded", token: TOKEN };
    },
  };
}

/** Test clock, so abandonment can be driven without waiting. */
const clock = { t: 1_000_000 };

function setup(initial?: SetupTokenPhase, verdict: { ok: true } | { ok: false; reason: string } = { ok: true }) {
  const fake = fakeSession(initial);
  clock.t = 1_000_000;
  const harness = createTestHarness({ manifest });
  const plugin = createClaudeAuthPlugin({
    startSession: () => fake.session,
    // Never spawn the real CLI in tests; the live check has its own coverage.
    verify: async () => verdict,
    now: () => clock.t,
  });
  return { harness, plugin, fake };
}

async function boot(
  initial?: SetupTokenPhase,
  verdict?: { ok: true } | { ok: false; reason: string },
) {
  const { harness, plugin, fake } = setup(initial, verdict);
  await plugin.definition.setup(harness.ctx);
  return { harness, fake };
}

const asUser = (userId: string) => ({
  actor: { type: "user" as const, userId, companyId: COMPANY },
  companyId: COMPANY,
});

describe("who may drive a sign-in", () => {
  let harness: Awaited<ReturnType<typeof boot>>["harness"];

  beforeEach(async () => {
    ({ harness } = await boot());
  });

  it("refuses an agent principal — it could harvest the credential it produces", async () => {
    await expect(
      harness.performAction("start", {}, {
        actor: { type: "agent", agentId: "agent-1", companyId: COMPANY },
        companyId: COMPANY,
      }),
    ).rejects.toThrow(/signed-in person/i);
  });

  it("refuses a call with no company scope", async () => {
    await expect(
      harness.performAction("start", {}, { actor: { type: "user", userId: ALICE } }),
    ).rejects.toThrow(/context of a company/i);
  });

  /**
   * The spoofing case the review named: companyId in params must not decide
   * scope. The host injects the authorized scope; a contradictory param is
   * simply ignored.
   */
  it("ignores a companyId supplied in params", async () => {
    await harness.performAction("start", { companyId: "not-my-company" }, asUser(ALICE));
    const status = await harness.performAction<{ state: string }>("poll", {}, asUser(ALICE));
    expect(status.state).not.toBe("idle");
  });
});

describe("a sign-in belongs to the person who started it", () => {
  it("does not hand another user the token", async () => {
    const { harness, fake } = await boot();
    await harness.performAction("start", {}, asUser(ALICE));
    fake.succeed();

    await expect(harness.performAction("poll", {}, asUser(BOB))).rejects.toThrow(
      /another person/i,
    );

    const mine = await harness.performAction<{ token?: string }>("poll", {}, asUser(ALICE));
    expect(mine.token).toBe(TOKEN);
  });

  it("delivers the token exactly once", async () => {
    const { harness, fake } = await boot();
    await harness.performAction("start", {}, asUser(ALICE));
    fake.succeed();

    const first = await harness.performAction<{ token?: string }>("poll", {}, asUser(ALICE));
    const second = await harness.performAction<{ token?: string; state: string }>(
      "poll", {}, asUser(ALICE),
    );
    expect(first.token).toBe(TOKEN);
    expect(second.token).toBeUndefined();
    expect(second.state).toBe("idle");
  });

  /**
   * The guard added after a truncated token reached the secret store and eight
   * agents: a credential that cannot authenticate must never be handed out.
   */
  it("withholds a token that fails verification", async () => {
    const { harness, fake } = await boot(undefined, {
      ok: false,
      reason: "The new token was rejected by Claude: 401 OAuth access token is invalid.",
    });
    await harness.performAction("start", {}, asUser(ALICE));
    fake.succeed();

    const result = await harness.performAction<{ state: string; token?: string; reason?: string }>(
      "poll", {}, asUser(ALICE),
    );
    expect(result.state).toBe("failed");
    expect(result.token).toBeUndefined();
    expect(result.reason).toMatch(/rejected by Claude/);
  });

  it("refuses a code from someone else", async () => {
    const { harness, fake } = await boot();
    await harness.performAction("start", {}, asUser(ALICE));
    await expect(
      harness.performAction("submit-code", { code: "abc123" }, asUser(BOB)),
    ).rejects.toThrow(/another person/i);
    expect(fake.submitted).toEqual([]);
  });

  it("does not let another user cancel a live sign-in", async () => {
    const { harness, fake } = await boot();
    await harness.performAction("start", {}, asUser(ALICE));
    await expect(harness.performAction("cancel", {}, asUser(BOB))).rejects.toThrow(
      /another person/i,
    );
    expect(fake.cancelled).toBeNull();
  });

  it("does not let another user displace a live sign-in by starting their own", async () => {
    const { harness, fake } = await boot();
    await harness.performAction("start", {}, asUser(ALICE));
    await expect(harness.performAction("start", {}, asUser(BOB))).rejects.toThrow(
      /another person/i,
    );
    expect(fake.cancelled).toBeNull();
  });

  it("lets another user replace a sign-in its owner abandoned", async () => {
    const { harness, fake } = await boot();
    await harness.performAction("start", {}, asUser(ALICE));
    clock.t += ABANDONED_AFTER_MS + 1;

    // The page load poll must not report an error for a dead attempt.
    await expect(harness.performAction("poll", {}, asUser(BOB))).resolves.toEqual({ state: "idle" });
    await expect(harness.performAction("start", {}, asUser(BOB))).resolves.toBeTruthy();
    expect(fake.cancelled).toMatch(/replaced/i);
  });

  it("does not treat a sign-in its owner is still polling as abandoned", async () => {
    const { harness, fake } = await boot();
    await harness.performAction("start", {}, asUser(ALICE));
    clock.t += ABANDONED_AFTER_MS - 1000;
    await harness.performAction("poll", {}, asUser(ALICE));
    clock.t += ABANDONED_AFTER_MS - 1000;
    await expect(harness.performAction("start", {}, asUser(BOB))).rejects.toThrow(
      /another person/i,
    );
    expect(fake.cancelled).toBeNull();
  });

  it("lets the owner restart their own sign-in", async () => {
    const { harness } = await boot();
    await harness.performAction("start", {}, asUser(ALICE));
    await expect(harness.performAction("start", {}, asUser(ALICE))).resolves.toBeTruthy();
  });
});

describe("diagnostics are one person's record, not a company log", () => {
  it("withholds a transcript from another user", async () => {
    const { harness, fake } = await boot();
    await harness.performAction("start", {}, asUser(ALICE));
    fake.session.cancel("stopped");
    await harness.performAction("poll", {}, asUser(ALICE)); // settles and remembers

    const theirs = await harness.performAction<{ transcript: string; phase: string }>(
      "diagnostics", {}, asUser(BOB),
    );
    expect(theirs.transcript).toBe("");
    expect(theirs.phase).toBe("none");

    const mine = await harness.performAction<{ transcript: string }>(
      "diagnostics", {}, asUser(ALICE),
    );
    expect(mine.transcript).toContain("Paste code here");
  });

  it("returns nothing when no run has happened", async () => {
    const { harness } = await boot();
    const empty = await harness.performAction<{ phase: string }>(
      "diagnostics", {}, asUser(ALICE),
    );
    expect(empty.phase).toBe("none");
  });
});
