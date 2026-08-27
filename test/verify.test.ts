import { describe, expect, it } from "vitest";
import { interpretAuthProbe } from "../src/setup-token/verify.js";

/**
 * `claude auth status` is not a validity check — it answered
 * `{"loggedIn": true, "authMethod": "oauth_token"}` for a deliberately bogus
 * token, because it only checks that a token is present. Only a real API round
 * trip separates a working credential from a plausible one, and `is_error` is
 * the field that carries the verdict.
 */
describe("interpretAuthProbe", () => {
  it("accepts a successful round trip", () => {
    const stdout = JSON.stringify({ is_error: false, duration_api_ms: 1551, num_turns: 1 });
    expect(interpretAuthProbe(stdout)).toEqual({ ok: true });
  });

  it("rejects the shape a bogus token produces", () => {
    const stdout = JSON.stringify({ is_error: true, duration_api_ms: 0, num_turns: 1 });
    const result = interpretAuthProbe(stdout);
    expect(result.ok).toBe(false);
  });

  it("surfaces Claude's own reason when it gives one", () => {
    const stdout = JSON.stringify({
      is_error: true,
      result: "Failed to authenticate. API Error: 401 OAuth access token is invalid.",
    });
    const result = interpretAuthProbe(stdout);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/401 OAuth access token is invalid/);
  });

  it.each([
    ["empty output", ""],
    ["non-JSON output", "command not found"],
    ["JSON with no verdict", JSON.stringify({ session_id: "abc" })],
  ])("fails closed on %s", (_label, stdout) => {
    // Storing a credential we could not confirm is the mistake this prevents.
    expect(interpretAuthProbe(stdout).ok).toBe(false);
  });
});
