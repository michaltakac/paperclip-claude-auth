import { describe, expect, it } from "vitest";
import {
  checkCodeAgainstUrl,
  derivePhase,
  extractAuthorizationState,
  extractAuthorizationUrl,
  extractToken,
  isAllowedAuthorizationUrl,
  redactForLogs,
  renderTerminalText,
} from "../src/setup-token/parse.js";

const ESC = "\x1b";
const AUTH_URL =
  "https://claude.com/cai/oauth/authorize?client_id=abc&code=1&code_challenge=xyz" +
  "&code_challenge_method=S256&redirect_uri=https%3A%2F%2Fexample&response_type=code" +
  "&scope=user&state=st4te";

/** OSC 8 hyperlink, as the terminal emits it. */
const link = (url: string, label = url) =>
  `${ESC}]8;id=1wmv9vp;${url}${ESC}\\${label}${ESC}]8;;${ESC}\\`;

/**
 * The prompt phase, shaped like the real capture from Claude Code 2.1.245:
 * CSI colour/cursor noise, a spinner frame redrawn with CR, and the hyperlink
 * repeated across wrapped display lines.
 */
const promptStream = [
  `${ESC}[?25l${ESC}[1mWelcome to Claude Code v2.1.245${ESC}[0m\r\n`,
  "This will guide you through long-lived (1-year) auth token setup for your\r\n",
  "Claude account. Claude subscription required.\r\n",
  `${ESC}[2K\r⠋ Opening browser to sign in…\r`,
  `${ESC}[2K\r⠙ Opening browser to sign in…\r`,
  "Browser didn't open? Use the url below to sign in (c to copy)\r\n",
  link(AUTH_URL, "https://claude.com/cai/oauth/autho"),
  link(AUTH_URL, "rize?client_id=abc&code=1..."),
  "\r\nHold Shift while selecting to use your terminal's native copy\r\n",
  "Paste code here if prompted > ",
].join("");

const successStream =
  promptStream +
  [
    "****\r\n\r\n",
    `${ESC}[32m✓${ESC}[0m Long-lived authentication token created successfully!\r\n\r\n`,
    "Your OAuth token (valid for 1 year):\r\n\r\n",
    "sk-ant-oat01-EXAMPLETOKENVALUE0123456789\r\n\r\n",
    "Store this token securely. You won't be able to see it again.\r\n\r\n",
    "Use this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>\r\n",
  ].join("");

/**
 * Claude Code lays out words by moving the cursor (`ESC [ n C`) instead of
 * emitting spaces. Deleting that sequence renders `Pastecodehereifprompted`,
 * which matched none of the phrase markers — so the prompt was never seen and,
 * far worse, a *successful* sign-in was invisible and got reported as a
 * rejected code. Observed live on 2.1.245.
 */
const cf = (n: number) => `${ESC}[${n}C`;
/** Cursor horizontal absolute — how Claude Code actually spaces words. */
const cha = (n: number) => `${ESC}[${n}G`;

const gluedSuccess = [
  `${ESC}[?25lWelcome${cf(1)}to${cf(1)}Claude${cf(1)}Code${cf(1)}v2.1.245\r\n`,
  link(AUTH_URL, "https://claude.com/cai/oauth/autho"),
  `\r\nPaste${cf(1)}code${cf(1)}here${cf(1)}if${cf(1)}prompted${cf(1)}>${cf(1)}`,
  "*******************\r\n",
  `${ESC}[32m✓${ESC}[0m${cf(1)}Long-lived${cf(1)}authentication${cf(1)}token${cf(1)}created${cf(1)}successfully!\r\n\r\n`,
  `Your${cf(1)}OAuth${cf(1)}token${cf(1)}(valid${cf(1)}for${cf(1)}1${cf(1)}year):\r\n\r\n`,
  "sk-ant-oat01-GLUEDSPACINGTOKEN01234\r\n",
].join("");

describe("cursor-forward word spacing", () => {
  it("restores spaces so phrase markers match", () => {
    const text = renderTerminalText(gluedSuccess);
    expect(text).toContain("Paste code here if prompted");
    expect(text).toContain("Long-lived authentication token created successfully");
  });

  it("sees the prompt instead of stalling in awaiting_authorization", () => {
    const prompt = gluedSuccess.split("*******************")[0]!;
    expect(derivePhase(prompt).kind).toBe("awaiting_code");
  });

  it("detects success — the failure that reported a good code as rejected", () => {
    expect(derivePhase(gluedSuccess)).toEqual({
      kind: "succeeded",
      token: "sk-ant-oat01-GLUEDSPACINGTOKEN01234",
    });
  });

  it("expands a multi-column cursor-forward", () => {
    expect(renderTerminalText(`a${cf(4)}b`)).toBe("a    b");
  });
});

/**
 * The real mechanism, observed on 2.1.245:
 *   Welcome\x1b[9Gto\x1b[12GClaude
 * Cursor-horizontal-absolute, not cursor-forward. Handling only the latter
 * still rendered `WelcometoClaude`, so every phrase marker missed.
 */
describe("cursor-horizontal-absolute word spacing", () => {
  it("pads out to the target column", () => {
    expect(renderTerminalText(`Welcome${cha(9)}to${cha(12)}Claude`)).toBe("Welcome to Claude");
  });

  it("resets the column on a line break, counting CRLF once", () => {
    expect(renderTerminalText(`abc\r\n${cha(3)}x`)).toBe("abc\n  x");
  });

  it("still breaks on a lone CR, so a spinner frame cannot glue onto what follows", () => {
    expect(renderTerminalText("frame\rdone")).toBe("frame\ndone");
  });

  it("never moves backwards", () => {
    expect(renderTerminalText(`abcdef${cha(2)}g`)).toBe("abcdefg");
  });

  it("sees the prompt through CHA spacing", () => {
    const promptCha =
      link(AUTH_URL) + `\r\n${cha(2)}Paste${cha(8)}code${cha(13)}here${cha(18)}if${cha(21)}prompted${cha(30)}>`;
    expect(derivePhase(promptCha).kind).toBe("awaiting_code");
  });
});

/**
 * A rejected code is reported explicitly — waiting out the 90s deadline to say
 * so is both slow and imprecise.
 */
describe("explicit rejection", () => {
  it("reads Claude's OAuth error instead of timing out", () => {
    const rejected =
      link(AUTH_URL) +
      `\r\nPaste code here if prompted >\r\n****\r\n` +
      `OAuth error: Requ${cha(20)}st failed with${cha(35)}status code 400\r\n Press Enter to retry.`;
    const phase = derivePhase(rejected);
    expect(phase.kind).toBe("failed");
    if (phase.kind === "failed") {
      expect(phase.reason).toMatch(/Claude rejected the sign-in/);
      expect(phase.reason).toMatch(/400/);
    }
  });

  it("still prefers success when both appear", () => {
    expect(derivePhase(gluedSuccess).kind).toBe("succeeded");
  });
});

describe("renderTerminalText", () => {
  it("strips CSI sequences and surfaces hyperlink targets", () => {
    const text = renderTerminalText(promptStream);
    expect(text).toContain("Welcome to Claude Code v2.1.245");
    expect(text).toContain("Paste code here if prompted");
    expect(text).not.toContain(ESC);
    expect(text).toContain(AUTH_URL);
  });

  it("keeps a spinner frame from gluing onto the next line", () => {
    const text = renderTerminalText(`${ESC}[2K\r⠋ working…\rdone`);
    expect(text).not.toContain("working…done");
  });
});

describe("extractAuthorizationUrl", () => {
  it("prefers the OSC 8 target, so wrapping never has to be reassembled", () => {
    expect(extractAuthorizationUrl(promptStream)).toBe(AUTH_URL);
  });

  it("falls back to unwrapping visible text when no hyperlink is emitted", () => {
    const wrapped =
      "Use the url below to sign in\r\n" +
      "https://claude.com/cai/oauth/authorize?client_id=abc&code=1&code_challenge=xyz\r\n" +
      "&code_challenge_method=S256&state=st4te\r\n";
    expect(extractAuthorizationUrl(wrapped)).toContain("/cai/oauth/authorize?");
  });

  it("returns null when nothing has been emitted yet", () => {
    expect(extractAuthorizationUrl("Welcome to Claude Code\r\n")).toBeNull();
  });

  it("drops a URL on a host we do not trust", () => {
    expect(extractAuthorizationUrl(link("https://evil.example/cai/oauth/authorize?x=1"))).toBeNull();
  });
});

describe("isAllowedAuthorizationUrl", () => {
  it.each([
    ["https://claude.com/cai/oauth/authorize?a=1", true],
    ["https://www.claude.com/cai/oauth/authorize", true],
    ["http://claude.com/cai/oauth/authorize", false],
    ["https://claude.com.evil.example/cai/oauth/authorize", false],
    ["https://claude.com/somewhere/else", false],
    ["not a url", false],
  ])("%s -> %s", (value, expected) => {
    expect(isAllowedAuthorizationUrl(value)).toBe(expected);
  });
});

/**
 * Regression: a ~108-character token wrapped across an 80-column PTY was read
 * as its first line only. The truncated string still looked like a credential,
 * so it was stored and bound, and only surfaced when an agent got
 * `401 OAuth access token is invalid`.
 */
describe("extractToken across a terminal wrap", () => {
  const WRAPPED_TOKEN =
    "sk-ant-oat01-" + "W".repeat(60) + "-" + "z".repeat(34);

  const wrappedSuccess =
    "✓ Long-lived authentication token created successfully!\r\n\r\n" +
    "Your OAuth token (valid for 1 year):\r\n\r\n" +
    WRAPPED_TOKEN.slice(0, 80) + "\r\n" +
    WRAPPED_TOKEN.slice(80) + "\r\n\r\n" +
    "Store this token securely. You won't be able to see it again.\r\n";

  it("rejoins the wrapped halves", () => {
    expect(extractToken(wrappedSuccess)).toBe(WRAPPED_TOKEN);
    expect(extractToken(wrappedSuccess)).toHaveLength(108);
  });

  it("stops at the prose that follows, never absorbing it", () => {
    const token = extractToken(wrappedSuccess);
    expect(token).not.toMatch(/Store|securely/);
  });

  it("reports success with the whole token", () => {
    expect(derivePhase(wrappedSuccess)).toEqual({ kind: "succeeded", token: WRAPPED_TOKEN });
  });
});

describe("extractToken", () => {
  it("reads the token that follows the heading", () => {
    expect(extractToken(successStream)).toBe("sk-ant-oat01-EXAMPLETOKENVALUE0123456789");
  });

  it("returns null before success", () => {
    expect(extractToken(promptStream)).toBeNull();
  });

  it("refuses prose, so a wording change cannot be bound as a credential", () => {
    const odd =
      "Your OAuth token (valid for 1 year):\r\n\r\nsomething went wrong here\r\n";
    expect(extractToken(odd)).toBeNull();
  });
});

describe("derivePhase", () => {
  it("starts before any URL appears", () => {
    expect(derivePhase("Welcome to Claude Code v2.1.245\r\n")).toEqual({ kind: "starting" });
  });

  it("waits on authorization once the URL is known", () => {
    const beforePrompt = promptStream.replace("Paste code here if prompted > ", "");
    expect(derivePhase(beforePrompt)).toEqual({
      kind: "awaiting_authorization",
      authorizationUrl: AUTH_URL,
    });
  });

  it("waits on the code once Claude prompts for it", () => {
    expect(derivePhase(promptStream)).toEqual({
      kind: "awaiting_code",
      authorizationUrl: AUTH_URL,
    });
  });

  it("succeeds with the token", () => {
    expect(derivePhase(successStream)).toEqual({
      kind: "succeeded",
      token: "sk-ant-oat01-EXAMPLETOKENVALUE0123456789",
    });
  });

  it("fails loudly when success is claimed but no token is readable", () => {
    const broken = promptStream + "✓ Long-lived authentication token created successfully!\r\n";
    const phase = derivePhase(broken);
    expect(phase.kind).toBe("failed");
  });
});

describe("redactForLogs", () => {
  it("removes the token and the PKCE query", () => {
    const redacted = redactForLogs(successStream);
    expect(redacted).not.toContain("sk-ant-oat01-EXAMPLETOKENVALUE0123456789");
    expect(redacted).toContain("<REDACTED_TOKEN>");
    expect(redacted).not.toContain("code_challenge=xyz");
    expect(redacted).not.toContain("state=st4te");
  });

  /**
   * Regression: the terminal hard-wraps the authorization URL, so a fragment
   * carrying the PKCE material appears on its own line with no scheme or host.
   * A whole-URL rule matched the canonical line and let every wrapped fragment
   * through. Observed on Claude Code 2.1.245.
   */
  it("redacts wrapped query fragments that carry no scheme or host", () => {
    const wrappedLeak =
      "https://claude.com/cai/oauth/authorize?client_id=abc\r\n" +
      "ed-5944d1962f5e&response_type=code&scope=user%3Ainference&code_challenge=XcKITx3k50Z\r\n" +
      "gsDHULB6VeTkBWJU0AO1wuO19ioBNH2I&code_challenge_method=S256&state=KM1IEoGZXDyqEMMI\r\n";
    const redacted = redactForLogs(wrappedLeak);
    expect(redacted).not.toContain("XcKITx3k50Z");
    expect(redacted).not.toContain("KM1IEoGZXDyqEMMI");
    expect(redacted).toContain("code_challenge=<REDACTED>");
    expect(redacted).toContain("state=<REDACTED>");
  });
});

describe("extractAuthorizationState", () => {
  it("reads the state the sign-in was issued with", () => {
    expect(extractAuthorizationState(AUTH_URL)).toBe("st4te");
  });

  it("returns null for a non-URL", () => {
    expect(extractAuthorizationState("nonsense")).toBeNull();
  });
});

/**
 * Claude gives no feedback at all on a bad code: it echoes the paste masked and
 * then sits silently on the prompt (characterized on 2.1.245 — no error, no
 * re-prompt, no exit, for the full wait). So the only way a user learns their
 * code is wrong is if we check it before submitting.
 */
describe("checkCodeAgainstUrl", () => {
  it("accepts a code carrying the matching state", () => {
    expect(checkCodeAgainstUrl("abc123#st4te", AUTH_URL)).toEqual({ ok: true });
  });

  it("rejects a code from an earlier sign-in", () => {
    const result = checkCodeAgainstUrl("abc123#old5tate", AUTH_URL);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/different sign-in/i);
  });

  it("accepts a code with no state, rather than blocking an unknown format", () => {
    expect(checkCodeAgainstUrl("justacode", AUTH_URL)).toEqual({ ok: true });
  });

  it("rejects an empty paste", () => {
    expect(checkCodeAgainstUrl("   ", AUTH_URL).ok).toBe(false);
  });

  it("rejects a paste that carried along other text", () => {
    const result = checkCodeAgainstUrl("the code is abc123#st4te", AUTH_URL);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/only the code/i);
  });
});
