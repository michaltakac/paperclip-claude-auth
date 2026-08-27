import { describe, expect, it } from "vitest";
import {
  derivePhase,
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
    expect(redacted).toContain("/cai/oauth/authorize?<REDACTED>");
  });
});
