/**
 * The whole point of this plugin: a sign-in a non-technical person can finish.
 *
 * No terminal, ever. The pseudo-terminal lives in the worker; what reaches this
 * component is a phase, a link to click, and one field to paste into.
 *
 * Two rules earn their keep here, both learned the hard way:
 *
 * 1. **The poll must never walk the user backwards.** After a code is
 *    submitted, the worker's phase stays `awaiting_code` until Claude either
 *    accepts it or the deadline fires. An earlier version re-rendered the paste
 *    form whenever a URL was present, so submitting appeared to do nothing at
 *    all. Progress is one-way: once we are verifying, only a terminal result
 *    moves us.
 * 2. **A bad code is answered with silence.** Claude prints nothing and waits.
 *    So the wait is bounded, visible, and counted — a spinner with no end in
 *    sight is indistinguishable from a hang.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ErrorBoundary,
  Spinner,
  StatusBadge,
  usePluginAction,
  usePluginToast,
} from "@paperclipai/plugin-sdk/ui";
import type { PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import { bindTokenToAgents, describeBindOutcome } from "./agents.js";
import {
  describeTokenSecret,
  findTokenSecret,
  storeTokenSecret,
  TOKEN_SECRET_KEY,
  type TokenSecretSummary,
} from "./secrets.js";

type Status = {
  state: "idle" | "starting" | "awaiting_authorization" | "awaiting_code" | "succeeded" | "failed";
  authorizationUrl?: string;
  reason?: string;
  token?: string;
  transcript?: string;
};

type Ui =
  | { view: "loading" }
  | { view: "idle" }
  | { view: "starting" }
  | { view: "authorize"; url: string; code: string; error?: string }
  | { view: "submitting"; url: string }
  | { view: "verifying"; startedAt: number }
  | { view: "storing" }
  | { view: "done"; message: string }
  | { view: "error"; message: string };

/**
 * The host applies an aggressive CSS reset to plugin UI, so bare <a>, <button>
 * and <input> render as unstyled text — a link is indistinguishable from a
 * sentence and two buttons read as one run-on line. Every control here is
 * styled explicitly. Colours come from host CSS variables where they exist so
 * the panel follows the active theme, with fallbacks for when they do not.
 */
const CONTROL: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  padding: "10px 16px",
  borderRadius: 8,
  fontSize: 14,
  fontWeight: 600,
  lineHeight: 1.2,
  cursor: "pointer",
  textDecoration: "none",
  border: "1px solid transparent",
  fontFamily: "inherit",
};

const PRIMARY: React.CSSProperties = {
  ...CONTROL,
  background: "var(--primary, #6366f1)",
  color: "var(--primary-foreground, #ffffff)",
};

const SECONDARY: React.CSSProperties = {
  ...CONTROL,
  background: "transparent",
  color: "inherit",
  borderColor: "var(--border, #3f3f46)",
};

const DISABLED: React.CSSProperties = { opacity: 0.5, cursor: "not-allowed" };

const INPUT: React.CSSProperties = {
  padding: "10px 12px",
  width: "100%",
  borderRadius: 8,
  border: "1px solid var(--border, #3f3f46)",
  background: "var(--input, rgba(255,255,255,0.04))",
  color: "inherit",
  fontSize: 14,
  fontFamily: "inherit",
};

const POLL_INTERVAL_MS = 1200;

/** Mirrors DEFAULT_CODE_ACCEPTANCE_TIMEOUT_MS in the worker. */
const VERIFY_BUDGET_SECONDS = 90;

export function ClaudeAuthSettingsPage({ context }: PluginWidgetProps) {
  if (!context.companyId) {
    return <p>Select a company to manage its Claude sign-in.</p>;
  }
  return (
    <ErrorBoundary>
      <ClaudeAuthSettings companyId={context.companyId} />
    </ErrorBoundary>
  );
}

function ClaudeAuthSettings({ companyId }: { companyId: string }) {
  const start = usePluginAction("start");
  const poll = usePluginAction("poll");
  const submitCode = usePluginAction("submit-code");
  const cancel = usePluginAction("cancel");
  const toast = usePluginToast();

  const [ui, setUi] = useState<Ui>({ view: "loading" });
  const [elapsed, setElapsed] = useState(0);
  /** What Claude is showing, redacted by the worker. */
  const [transcript, setTranscript] = useState("");
  /** The stored credential, so the panel can answer "am I signed in?" on load. */
  const [summary, setSummary] = useState<TokenSecretSummary | null>(null);

  const refreshSummary = useCallback(async () => {
    try {
      setSummary(await describeTokenSecret(companyId));
    } catch {
      setSummary(null);
    }
  }, [companyId]);
  const uiRef = useRef<Ui>(ui);
  uiRef.current = ui;

  /**
   * Handle a terminal phase. The token arrives exactly once — in the reply to
   * the poll that observes success — so it is stored in the same tick and never
   * held in component state.
   */
  const consume = useCallback(
    async (status: Status): Promise<boolean> => {
      if (status.state === "succeeded") {
        if (!status.token) {
          setUi({
            view: "error",
            message: "The sign-in finished but no token arrived. Please start again.",
          });
          return true;
        }
        setUi({ view: "storing" });
        try {
          const outcome = await storeTokenSecret(companyId, status.token);
          const stored =
            outcome.action === "rotated"
              ? `Signed in. ${TOKEN_SECRET_KEY} was updated and is valid for a year.`
              : `Signed in. ${TOKEN_SECRET_KEY} was created and is valid for a year.`;

          // Storing the secret is only half the job — an unbound secret reaches
          // no agent. Connect them, but never fail the sign-in over it: the
          // token is safely stored by this point and cannot be minted again.
          let connected = "";
          try {
            connected = describeBindOutcome(await bindTokenToAgents(companyId, outcome.id));
          } catch (error) {
            connected =
              "The token is stored, but connecting it to your agents failed: " +
              `${error instanceof Error ? error.message : String(error)}. ` +
              "Add it manually under Secrets → Agent access.";
          }
          const message = `${stored} ${connected}`;
          setUi({ view: "done", message });
          void refreshSummary();
          toast({ title: "Claude sign-in complete", body: message, tone: "success" });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          setUi({
            view: "error",
            message:
              `Signed in, but the token could not be saved: ${reason}. ` +
              "The token cannot be shown again, so please sign in once more.",
          });
        }
        return true;
      }
      if (status.state === "failed") {
        const message = status.reason ?? "The sign-in failed.";
        setUi({ view: "error", message });
        toast({ title: "Claude sign-in failed", body: message, tone: "error" });
        return true;
      }
      return false;
    },
    [companyId, toast, refreshSummary],
  );

  /** Resume whatever the worker already has, so a refresh is not a dead end. */
  useEffect(() => {
    let cancelled = false;
    void refreshSummary();
    void (async () => {
      try {
        const status = (await poll({ companyId })) as Status;
        if (cancelled) return;
        if (await consume(status)) return;
        if (status.authorizationUrl) {
          setUi({ view: "authorize", url: status.authorizationUrl, code: "" });
        } else {
          setUi({ view: "idle" });
        }
      } catch {
        if (!cancelled) setUi({ view: "idle" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId, poll, consume, refreshSummary]);

  // Poll while something is in flight. Never regresses the view.
  useEffect(() => {
    const live =
      ui.view === "starting" || ui.view === "authorize" || ui.view === "verifying";
    if (!live) return;

    let cancelled = false;
    const timer = setInterval(async () => {
      if (cancelled) return;
      try {
        const status = (await poll({ companyId })) as Status;
        if (cancelled) return;
        if (status.transcript) setTranscript(status.transcript);
        if (await consume(status)) return;

        // Only ever move forward. While verifying, `awaiting_code` is the
        // expected steady state — it is not a reason to show the form again.
        const current = uiRef.current;
        if (current.view === "starting" && status.authorizationUrl) {
          setUi({ view: "authorize", url: status.authorizationUrl, code: "" });
          return;
        }
        // The worker reports `idle` once a finished session is cleaned up. If
        // that happens while we are waiting, the outcome was consumed by
        // another poll and we would otherwise spin forever on a dead session.
        if (status.state === "idle" && current.view === "verifying") {
          setUi({
            view: "error",
            message:
              "The sign-in ended without reporting a result. Run the diagnostics action to see " +
              "what Claude printed, then start again.",
          });
        }
      } catch {
        /* transient; the next tick retries */
      }
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [ui.view, companyId, poll, consume]);

  // A visible countdown while Claude decides. Silence is the only failure
  // signal it gives, so the wait has to look like progress, not a hang.
  useEffect(() => {
    if (ui.view !== "verifying") {
      setElapsed(0);
      return;
    }
    const startedAt = ui.startedAt;
    const timer = setInterval(
      () => setElapsed(Math.floor((Date.now() - startedAt) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [ui]);

  const onStart = async () => {
    setUi({ view: "starting" });
    try {
      const status = (await start({ companyId })) as Status;
      if (await consume(status)) return;
      if (status.authorizationUrl) {
        setUi({ view: "authorize", url: status.authorizationUrl, code: "" });
      }
    } catch (error) {
      setUi({ view: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const onSubmit = async () => {
    if (ui.view !== "authorize" || !ui.code.trim()) return;
    const url = ui.url;
    setUi({ view: "submitting", url });
    try {
      await submitCode({ companyId, code: ui.code.trim() });
      setUi({ view: "verifying", startedAt: Date.now() });
    } catch (error) {
      // Our own pre-flight check against the sign-in's state — Claude itself
      // says nothing at all about a bad code.
      setUi({
        view: "authorize",
        url,
        code: "",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  /** Bind an already-stored token to agents, without a fresh sign-in. */
  const onConnectAgents = async () => {
    const secret = summary;
    if (!secret?.present) return;
    setUi({ view: "storing" });
    try {
      const record = await findTokenSecret(companyId);
      if (!record) throw new Error("The stored token could not be found.");
      const message = describeBindOutcome(await bindTokenToAgents(companyId, record.id));
      setUi({ view: "done", message });
      void refreshSummary();
      toast({ title: "Agents connected", body: message, tone: "success" });
    } catch (error) {
      setUi({
        view: "error",
        message: `Could not connect your agents: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  };

  const onCancel = async () => {
    try {
      await cancel({ companyId });
    } finally {
      setUi({ view: "idle" });
    }
  };

  const remaining = Math.max(0, VERIFY_BUDGET_SECONDS - elapsed);

  return (
    <section style={{ maxWidth: 620, display: "grid", gap: 20 }}>
      <header style={{ display: "grid", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <h3 style={{ margin: 0 }}>Claude sign-in</h3>
          <StatusBadge {...badgeFor(ui, summary)} />
        </div>
        <p style={{ margin: 0, opacity: 0.75 }}>
          Signs your agents in to Claude for a year. You will need the Claude account that
          owns the subscription.
        </p>
      </header>

      {ui.view === "loading" && <Spinner size="sm" label="Checking sign-in state" />}

      {ui.view === "idle" && (
        <div style={{ display: "grid", gap: 12 }}>
          <TokenSummary summary={summary} />
          <div>
            <button type="button" onClick={onStart} style={PRIMARY}>
              {summary?.present ? "Sign in again" : "Sign in to Claude"}
            </button>
          </div>
          {summary?.present && summary.bindings === 0 && (
            <div>
              <button type="button" onClick={onConnectAgents} style={SECONDARY}>
                Connect agents to this token
              </button>
            </div>
          )}
          {summary?.present && (
            <p style={{ margin: 0, opacity: 0.7, fontSize: 13 }}>
              Signing in again mints a fresh token and replaces {TOKEN_SECRET_KEY} in place,
              keeping its history. Your agents keep working throughout.
            </p>
          )}
        </div>
      )}

      {ui.view === "starting" && (
        <Row>
          <Spinner size="sm" label="Preparing sign-in" />
          <span>Preparing your sign-in link…</span>
        </Row>
      )}

      {(ui.view === "authorize" || ui.view === "submitting") && (
        <div style={{ display: "grid", gap: 14 }}>
          <Step n={1}>
            <a href={ui.url} target="_blank" rel="noreferrer noopener" style={PRIMARY}>
              Open Claude and approve the sign-in
              <span aria-hidden="true">↗</span>
            </a>
          </Step>
          <Step n={2}>Copy the code Claude shows you and paste it here.</Step>

          {ui.view === "authorize" ? (
            <>
              <input
                type="text"
                value={ui.code}
                placeholder="Paste the code from Claude"
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setUi({ ...ui, code: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void onSubmit();
                }}
                style={INPUT}
              />
              {ui.error && (
                <p role="alert" style={{ margin: 0, color: "var(--destructive, #f87171)" }}>
                  {ui.error}
                </p>
              )}
              <Row>
                <button
                  type="button"
                  onClick={onSubmit}
                  disabled={!ui.code.trim()}
                  style={ui.code.trim() ? PRIMARY : { ...PRIMARY, ...DISABLED }}
                >
                  Finish sign-in
                </button>
                <button type="button" onClick={onCancel} style={SECONDARY}>
                  Cancel
                </button>
              </Row>
            </>
          ) : (
            <Row>
              <Spinner size="sm" label="Sending code" />
              <span>Sending your code…</span>
            </Row>
          )}
        </div>
      )}

      {ui.view === "verifying" && (
        <div style={{ display: "grid", gap: 10 }}>
          <Row>
            <Spinner size="sm" label="Waiting for Claude" />
            <span>Waiting for Claude to accept the code…</span>
          </Row>
          <p style={{ margin: 0, opacity: 0.7 }}>
            Claude gives no answer until it succeeds, so this can take a moment. Giving up
            in {remaining}s if nothing comes back.
          </p>
          <div>
            <button type="button" onClick={onCancel} style={SECONDARY}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {(ui.view === "verifying" || ui.view === "error" || ui.view === "authorize") &&
        transcript.trim() && <ClaudeOutput text={transcript} />}

      {ui.view === "storing" && (
        <Row>
          <Spinner size="sm" label="Storing token" />
          <span>Storing your token…</span>
        </Row>
      )}

      {ui.view === "done" && (
        <div style={{ display: "grid", gap: 10 }}>
          <p style={{ margin: 0 }}>{ui.message}</p>
          <TokenSummary summary={summary} />
          <div>
            <button type="button" onClick={() => setUi({ view: "idle" })} style={SECONDARY}>
              Done
            </button>
          </div>
        </div>
      )}

      {ui.view === "error" && (
        <div style={{ display: "grid", gap: 10 }}>
          <p role="alert" style={{ margin: 0, color: "var(--destructive, #f87171)" }}>
            {ui.message}
          </p>
          <div>
            <button type="button" onClick={onStart} style={PRIMARY}>
              Start again
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * What Claude is showing, verbatim.
 *
 * Claude answers a bad code with silence, so without this the user stares at a
 * spinner with no idea whether anything is happening. The text is redacted by
 * the worker — no token, no PKCE query — and the submitted code is masked by
 * Claude itself.
 */
function ClaudeOutput({ text }: { text: string }) {
  const lines = text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line, index, all) => line !== "" || all[index - 1] !== "");
  return (
    <details open style={{ borderTop: "1px solid var(--border, #3f3f46)", paddingTop: 12 }}>
      <summary style={{ cursor: "pointer", opacity: 0.8, marginBottom: 8 }}>
        What Claude is showing
      </summary>
      <pre
        style={{
          margin: 0,
          padding: 12,
          maxHeight: 240,
          overflow: "auto",
          borderRadius: 8,
          background: "var(--muted, rgba(255,255,255,0.04))",
          border: "1px solid var(--border, #3f3f46)",
          fontSize: 12,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {lines.join("\n")}
      </pre>
    </details>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: "flex", alignItems: "center", gap: 8 }}>{children}</div>;
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "baseline" }}>
      <span style={{ opacity: 0.6, fontVariantNumeric: "tabular-nums" }}>{n}.</span>
      <div>{children}</div>
    </div>
  );
}

type Badge = { label: string; status: "ok" | "warning" | "error" | "info" | "pending" };

/**
 * When nothing is in flight the badge describes the *stored credential*, not
 * the last thing the user did — that is the question someone opening this page
 * actually has.
 */
function badgeFor(ui: Ui, summary: TokenSecretSummary | null): Badge {
  if (ui.view === "loading") return { label: "Checking", status: "pending" };
  if (ui.view === "error") return { label: "Failed", status: "error" };

  if (ui.view === "idle" || ui.view === "done") {
    if (!summary) return { label: "Checking", status: "pending" };
    if (!summary.present) return { label: "Not signed in", status: "info" };
    const days = summary.daysLeft;
    if (typeof days !== "number") return { label: "Signed in", status: "ok" };
    if (days <= 0) return { label: "Expired", status: "error" };
    if (days <= 30) return { label: `Expires in ${days}d`, status: "warning" };
    return { label: "Signed in", status: "ok" };
  }

  return { label: "In progress", status: "pending" };
}

const DATE_FORMAT: Intl.DateTimeFormatOptions = {
  year: "numeric",
  month: "short",
  day: "numeric",
};

/** The standing answer to "am I signed in, and for how much longer?" */
function TokenSummary({ summary }: { summary: TokenSecretSummary | null }) {
  if (!summary) return null;

  if (!summary.present) {
    return (
      <p style={{ margin: 0, opacity: 0.8 }}>
        No Claude token is stored yet. Your agents cannot reach Claude until you sign in.
      </p>
    );
  }

  const expires = summary.expiresAt ? new Date(summary.expiresAt) : null;
  const signedIn = summary.signedInAt ? new Date(summary.signedInAt) : null;
  const days = summary.daysLeft;
  const expired = typeof days === "number" && days <= 0;

  return (
    <div style={{ display: "grid", gap: 4 }}>
      <p style={{ margin: 0, fontWeight: 600 }}>
        {expired
          ? `${TOKEN_SECRET_KEY} has expired.`
          : `${TOKEN_SECRET_KEY} is stored and in use.`}
      </p>
      <p style={{ margin: 0, opacity: 0.75, fontSize: 13 }}>
        {signedIn && `Signed in ${signedIn.toLocaleDateString(undefined, DATE_FORMAT)}.`}
        {expires &&
          ` ${expired ? "Expired" : "Valid until"} ${expires.toLocaleDateString(undefined, DATE_FORMAT)}`}
        {typeof days === "number" && !expired && ` — ${days} days left.`}
        {typeof summary.version === "number" &&
          summary.version > 1 &&
          ` Renewed ${summary.version - 1}×.`}
      </p>
      {summary.bindings === 0 && (
        <p style={{ margin: "4px 0 0", color: "var(--warning, #fbbf24)", fontSize: 13 }}>
          Not yet bound to any agent. The token is stored, but no agent receives it until
          it is added under Secrets → this secret → Agent access, as the environment
          variable {TOKEN_SECRET_KEY}.
        </p>
      )}
    </div>
  );
}

export default ClaudeAuthSettingsPage;
