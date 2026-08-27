/**
 * Parser for the `claude setup-token` pseudo-terminal session.
 *
 * Everything here is pure: it takes raw PTY bytes and derives a phase. That
 * matters because the raw stream carries a one-time secret — the token is
 * printed exactly once and, in Claude Code's own words, "You won't be able to
 * see it again". Keeping extraction pure lets us test it against characterized
 * output without ever putting a real token near a log sink.
 *
 * Characterized against Claude Code 2.1.205 (upstream Paperclip fixtures,
 * 2026-08-11 / 2026-08-12) and re-observed on 2.1.245. The CLI renders through
 * a terminal, so consumers must tolerate ANSI CSI sequences, OSC 8 hyperlinks,
 * spinner frames, cursor-forward word spacing, and hard line wrapping in the
 * middle of the authorization URL.
 */

/** Hosts an authorization URL is allowed to point at. Anything else is dropped. */
export const DEFAULT_ALLOWED_AUTH_HOSTS = ["claude.com", "www.claude.com"] as const;

/** Path the OAuth authorize URL must use. */
const AUTHORIZE_PATH = "/cai/oauth/authorize";

/** Emitted once the browser authorization succeeds. */
const SUCCESS_MARKER = "Long-lived authentication token created successfully";

/** Precedes the token itself. */
const TOKEN_HEADING = /Your OAuth token \(valid for [^)]+\):/;

/** The interactive prompt that waits for the browser code. */
const CODE_PROMPT = /Paste code here if prompted\s*>/;

/** OSC 8 hyperlink: ESC ] 8 ; params ; URI (BEL | ESC backslash) */
const OSC8 = /\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

/** Any other OSC string. */
const OSC_OTHER = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** CSI sequences (colour, cursor movement, erase, ...). */
const CSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;

/** Single-character escapes left over after the above. */
const ESC_SINGLE = /\x1b[@-Z\\-_]/g;

export type SetupTokenPhase =
  /** Process started, nothing recognisable emitted yet. */
  | { kind: "starting" }
  /** The authorization URL is available; the human must approve in a browser. */
  | { kind: "awaiting_authorization"; authorizationUrl: string }
  /** Claude is waiting for the code the browser handed back. */
  | { kind: "awaiting_code"; authorizationUrl: string }
  /** Done. `token` is a one-time secret — bind it and drop it. */
  | { kind: "succeeded"; token: string }
  /** Terminal failure. `reason` is safe to show a user. */
  | { kind: "failed"; reason: string };

/**
 * Strip terminal control sequences, leaving readable text.
 *
 * OSC 8 hyperlinks are replaced by their URI so a wrapped display URL never has
 * to be reassembled from screen output — the hyperlink parameter carries the
 * whole thing on one line.
 */
export function renderTerminalText(raw: string): string {
  return raw
    .replace(OSC8, (_match, uri: string) => `\n${uri}\n`)
    .replace(OSC_OTHER, "")
    .replace(CSI, "")
    .replace(ESC_SINGLE, "")
    // A PTY uses CR to redraw spinner frames in place; treat it as a line break
    // so a frame can never glue itself to the text that follows.
    .replace(/\r/g, "\n");
}

/**
 * Pull the authorization URL out of a raw PTY stream.
 *
 * Returns null when no URL has appeared yet, or when every candidate failed the
 * host/path check — a URL we would render as a button must be one we trust.
 */
export function extractAuthorizationUrl(
  raw: string,
  allowedHosts: readonly string[] = DEFAULT_ALLOWED_AUTH_HOSTS,
): string | null {
  const candidates: string[] = [];

  for (const match of raw.matchAll(OSC8)) {
    if (match[1]) candidates.push(match[1]);
  }
  // Fall back to the visible text. The URL may be wrapped, so join the wrap
  // before scanning; this is only reached when the terminal emitted no OSC 8.
  if (candidates.length === 0) {
    const unwrapped = renderTerminalText(raw).replace(/\n(?=[^\s])/g, "");
    for (const match of unwrapped.matchAll(/https:\/\/\S+/g)) {
      candidates.push(match[0].replace(/[).,]+$/, ""));
    }
  }

  for (const candidate of candidates) {
    if (isAllowedAuthorizationUrl(candidate, allowedHosts)) return candidate;
  }
  return null;
}

/** True when a URL is an authorization URL on an allowed host. */
export function isAllowedAuthorizationUrl(
  value: string,
  allowedHosts: readonly string[] = DEFAULT_ALLOWED_AUTH_HOSTS,
): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (!allowedHosts.includes(url.hostname)) return false;
  return url.pathname === AUTHORIZE_PATH;
}

/**
 * Pull the one-time token out of a completed session.
 *
 * The token sits on its own line after the "Your OAuth token" heading. We take
 * the first non-empty line and reject anything that looks like prose, so a
 * wording change upstream degrades into "not found" rather than binding a
 * sentence as a credential.
 */
export function extractToken(raw: string): string | null {
  const text = renderTerminalText(raw);
  const heading = text.match(TOKEN_HEADING);
  if (!heading || heading.index === undefined) return null;

  const after = text.slice(heading.index + heading[0].length);
  for (const line of after.split("\n")) {
    const candidate = line.trim();
    if (!candidate) continue;
    return looksLikeToken(candidate) ? candidate : null;
  }
  return null;
}

/**
 * A conservative shape check. We do not pin a prefix — that would break the
 * moment Anthropic rotates their token format — but a credential is one opaque
 * word, so anything containing whitespace is prose we misread.
 */
export function looksLikeToken(value: string): boolean {
  return value.length >= 20 && !/\s/.test(value) && /^[\x21-\x7e]+$/.test(value);
}

/** Derive the current phase from everything the PTY has emitted so far. */
export function derivePhase(
  raw: string,
  allowedHosts: readonly string[] = DEFAULT_ALLOWED_AUTH_HOSTS,
): SetupTokenPhase {
  const text = renderTerminalText(raw);

  if (text.includes(SUCCESS_MARKER)) {
    const token = extractToken(raw);
    return token
      ? { kind: "succeeded", token }
      : {
          kind: "failed",
          reason:
            "Claude reported success but the token could not be read from its output. " +
            "This usually means the Claude Code output format changed.",
        };
  }

  const authorizationUrl = extractAuthorizationUrl(raw, allowedHosts);
  if (!authorizationUrl) return { kind: "starting" };

  return CODE_PROMPT.test(text)
    ? { kind: "awaiting_code", authorizationUrl }
    : { kind: "awaiting_authorization", authorizationUrl };
}

/**
 * Redact a PTY stream so it can be logged.
 *
 * Removes the token and the authorization URL's query, which carries the PKCE
 * challenge and state. Use this on every path that writes PTY output anywhere.
 */
export function redactForLogs(raw: string): string {
  let text = renderTerminalText(raw);
  const token = extractToken(raw);
  if (token) text = text.split(token).join("<REDACTED_TOKEN>");
  return text.replace(
    /(https:\/\/[^\s?]+\/cai\/oauth\/authorize)\?\S*/g,
    "$1?<REDACTED>",
  );
}
