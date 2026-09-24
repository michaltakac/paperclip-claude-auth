import { describe, expect, it } from "vitest";
import { errorMessage } from "../src/ui/errors.js";

describe("errorMessage", () => {
  it("reads a PluginBridgeError, which is a plain object and not an Error", () => {
    const bridgeError = { code: "WORKER_ERROR", message: "Another person is signing in." };
    expect(errorMessage(bridgeError)).toBe("Another person is signing in.");
    expect(errorMessage(bridgeError)).not.toContain("[object Object]");
  });

  it("reads an ordinary Error", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("reads a host REST body of the form { error }", () => {
    expect(errorMessage({ error: "Plugin not found" })).toBe("Plugin not found");
  });

  it("falls back instead of printing [object Object]", () => {
    expect(errorMessage({}, "fallback")).toBe("fallback");
    expect(errorMessage(null, "fallback")).toBe("fallback");
  });
});
