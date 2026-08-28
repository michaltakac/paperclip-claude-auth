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

/**
 * Markers are matched whitespace-tolerantly (`\s*` between words) because the
 * terminal does not always emit literal spaces — see {@link renderTerminalText}.
 * Even with cursor-forward restored, a wrap can land mid-phrase.
 */

/** Emitted once the browser authorization succeeds. */
const SUCCESS_MARKER = /Long-?\s*lived\s*authentication\s*token\s*created\s*successfully/i;

/** Precedes the token itself. */
const TOKEN_HEADING = /Your\s*OAuth\s*token\s*\(\s*valid\s*for[^)]*\)\s*:/i;

/** The interactive prompt that waits for the browser code. */
const CODE_PROMPT = /Paste\s*code\s*here\s*if\s*prompted/i;

/**
 * Claude reports a rejected code explicitly — `OAuth error: Request failed with
 * status code 400`, followed by `Press Enter to retry.` Detecting it turns a
 * 90-second wait into an immediate, accurate answer.
 *
 * The message is redrawn with cursor motion, so words can be split mid-token;
 * match loosely and report what we can read.
 */
const OAUTH_ERROR = /OAuth\s*error\s*:?\s*([^\n]{0,120})/i;

/** OSC 8 hyperlink: ESC ] 8 ; params ; URI (BEL | ESC backslash) */
const OSC8 = /\x1b\]8;[^;]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

/** Any other OSC string. */
const OSC_OTHER = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** One CSI sequence, anchored: params, intermediates, final byte. */
const CSI_ONE = /^\x1b\[([0-9;?]*)([ -\/]*)([@-~])/;

/** One two-character escape, anchored. */
const ESC_SINGLE_ONE = /^\x1b[@-Z\\-_]/;

/** Never emit an unbounded run of spaces from a malformed column value. */
const MAX_PAD_COLUMNS = 200;

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
 * Render terminal output as readable text.
 *
 * Claude Code positions words with **cursor motion, not spaces**:
 * `Welcome\x1b[9Gto\x1b[12GClaude`. Deleting those sequences yields
 * `WelcometoClaude`, which matches none of the phrase markers — so the prompt
 * was never detected and, worse, a successful sign-in was invisible.
 *
 * So this walks the stream keeping a column counter and turns cursor motion
 * back into spaces:
 *   - `ESC [ n G` — cursor horizontal absolute: pad out to column n.
 *   - `ESC [ n C` — cursor forward: emit n spaces.
 * Everything else is dropped. OSC 8 hyperlink targets are lifted onto their own
 * line first, so a wrapped URL never has to be reassembled from screen text.
 */
export function renderTerminalText(raw: string): string {
  const source = raw.replace(OSC8, (_match, uri: string) => `\n${uri}\n`).replace(OSC_OTHER, "");

  let out = "";
  let column = 0;
  let i = 0;

  const pad = (count: number) => {
    const n = Math.min(MAX_PAD_COLUMNS, Math.max(0, count));
    out += " ".repeat(n);
    column += n;
  };

  while (i < source.length) {
    const char = source[i]!;

    if (char === "\x1b") {
      const csi = CSI_ONE.exec(source.slice(i));
      if (csi) {
        const params = csi[1] ?? "";
        const final = csi[3];
        if (final === "G") {
          const target = Math.max(1, Number.parseInt(params || "1", 10));
          if (target - 1 > column) pad(target - 1 - column);
        } else if (final === "C") {
          pad(Math.max(1, Number.parseInt(params || "1", 10)));
        }
        i += csi[0].length;
        continue;
      }
      const single = ESC_SINGLE_ONE.exec(source.slice(i));
      i += single ? single[0].length : 1;
      continue;
    }

    // A PTY redraws in place with CR, so a lone CR is treated as a line break —
    // that keeps a spinner frame from gluing onto the text after it. But CRLF
    // is ONE break, not two: mapping each half separately inserted a blank line
    // after every real line, which made a wrapped token look like it had ended
    // and truncated the credential.
    if (char === "\r" || char === "\n") {
      out += "\n";
      column = 0;
      i += char === "\r" && source[i + 1] === "\n" ? 2 : 1;
      continue;
    }

    out += char;
    column += 1;
    i += 1;
  }

  return out;
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
 * **The token wraps.** `script` allocates an 80-column pseudo-terminal and the
 * credential is ~108 characters, so it arrives split across two display lines.
 * An earlier version took only the first line and stored a truncated token,
 * which Anthropic rejected with `401 OAuth access token is invalid` — and,
 * because the truncated string still looked like a credential, nothing caught
 * it until an agent tried to use it.
 *
 * So consecutive whitespace-free lines are joined. Prose ends the run: the
 * block is followed by a blank line and "Store this token securely", and any
 * line containing a space is text rather than more credential.
 */
export function extractToken(raw: string): string | null {
  const text = renderTerminalText(raw);
  const heading = text.match(TOKEN_HEADING);
  if (!heading || heading.index === undefined) return null;

  const after = text.slice(heading.index + heading[0].length);
  const parts: string[] = [];

  for (const line of after.split("\n")) {
    const candidate = line.trim();
    if (!candidate) {
      // Blank lines precede the token; once it has started, one ends it.
      if (parts.length) break;
      continue;
    }
    // Prose, not credential — stop rather than append a sentence.
    if (/\s/.test(candidate) || !/^[\x21-\x7e]+$/.test(candidate)) break;
    parts.push(candidate);
  }

  if (!parts.length) return null;
  const token = parts.join("");
  return looksLikeToken(token) ? token : null;
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

  // Success is decided by whether a credential can actually be read, not by the
  // banner above it. Banner wording varies between Claude Code versions —
  // 2.1.245 prints a "long-lived (1-year)" intro that 2.1.207 does not — and
  // keying success off prose would make this brittle across upgrades. The
  // token's own shape is checked by `extractToken`, and the worker proves it
  // against the real API before anything stores it.
  const token = extractToken(raw);
  if (token) return { kind: "succeeded", token };

  if (SUCCESS_MARKER.test(text)) {
    return {
      kind: "failed",
      reason:
        "Claude reported success but the token could not be read from its output. " +
        "This usually means the Claude Code output format changed.",
    };
  }

  const oauthError = text.match(OAUTH_ERROR);
  if (oauthError) {
    const detail = (oauthError[1] ?? "").replace(/\s+/g, " ").trim();
    return {
      kind: "failed",
      reason: detail
        ? `Claude rejected the sign-in — ${detail}. Open the link again and copy the new code.`
        : "Claude rejected the sign-in. Open the link again and copy the new code.",
    };
  }

  const authorizationUrl = extractAuthorizationUrl(raw, allowedHosts);
  if (!authorizationUrl) return { kind: "starting" };

  return CODE_PROMPT.test(text)
    ? { kind: "awaiting_code", authorizationUrl }
    : { kind: "awaiting_authorization", authorizationUrl };
}

/** Query parameters whose values must never reach a log. */
const SENSITIVE_QUERY_KEYS = ["code_challenge", "state", "client_id", "code"] as const;

/**
 * Redact a PTY stream so it can be logged.
 *
 * Removes the token and the OAuth query parameters, which carry the PKCE
 * challenge and state. Use this on every path that writes PTY output anywhere.
 *
 * Redaction is done per-parameter rather than per-URL on purpose. The terminal
 * hard-wraps the authorization URL across display lines, so a continuation
 * fragment like `...&code_challenge=XcK...&state=KM1...` appears with no scheme
 * or host in front of it. An earlier whole-URL rule matched the canonical line
 * and let every wrapped fragment through — which is precisely the material this
 * function exists to suppress. Observed on Claude Code 2.1.245.
 */
export function redactForLogs(raw: string): string {
  let text = renderTerminalText(raw);
  const token = extractToken(raw);
  if (token) text = text.split(token).join("<REDACTED_TOKEN>");
  for (const key of SENSITIVE_QUERY_KEYS) {
    text = text.replace(
      new RegExp(`(\\b${key}=)[^&\\s]+`, "g"),
      "$1<REDACTED>",
    );
  }
  return text;
}

/**
 * The `state` the authorization URL was issued with.
 *
 * The browser hands the user back a code carrying this same state, which is the
 * only way to tell a mistyped or stale code from a good one — see
 * {@link checkCodeAgainstUrl}.
 */
export function extractAuthorizationState(authorizationUrl: string): string | null {
  try {
    return new URL(authorizationUrl).searchParams.get("state");
  } catch {
    return null;
  }
}

export type CodeCheck = { ok: true } | { ok: false; reason: string };

/**
 * Check a pasted code against the sign-in it belongs to, before submitting it.
 *
 * This exists because Claude Code gives **no feedback whatsoever** on a bad
 * code: the code is echoed masked and the process then sits silently on its
 * prompt indefinitely (characterized on 2.1.245 — no error, no re-prompt, no
 * exit). There is no message to parse, so the only way to tell a user their
 * code was wrong is to check it ourselves first.
 *
 * The browser returns `<code>#<state>`. When the paste carries a state we can
 * compare it; when it carries none we cannot verify it and let it through
 * rather than block a flow whose format changed.
 */
export function checkCodeAgainstUrl(code: string, authorizationUrl: string): CodeCheck {
  const trimmed = code.trim();
  if (!trimmed) {
    return { ok: false, reason: "Paste the code from your browser to continue." };
  }
  if (/\s/.test(trimmed)) {
    return {
      ok: false,
      reason: "That looks like more than just the code — paste only the code your browser showed.",
    };
  }

  const separator = trimmed.indexOf("#");
  if (separator === -1) return { ok: true };

  const pastedState = trimmed.slice(separator + 1);
  const expectedState = extractAuthorizationState(authorizationUrl);
  if (!expectedState) return { ok: true };

  if (pastedState !== expectedState) {
    return {
      ok: false,
      reason:
        "That code belongs to a different sign-in — it was probably copied from an earlier attempt. " +
        "Open the link again and copy the new code.",
    };
  }
  return { ok: true };
}
