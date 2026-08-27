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
import { storeTokenSecret, TOKEN_SECRET_KEY } from "./secrets.js";

type Status = {
  state: "idle" | "starting" | "awaiting_authorization" | "awaiting_code" | "succeeded" | "failed";
  authorizationUrl?: string;
  reason?: string;
  token?: string;
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
          const message =
            outcome.action === "rotated"
              ? `Signed in. ${TOKEN_SECRET_KEY} was updated and is valid for a year.`
              : `Signed in. ${TOKEN_SECRET_KEY} was created and is valid for a year.`;
          setUi({ view: "done", message });
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
    [companyId, toast],
  );

  /** Resume whatever the worker already has, so a refresh is not a dead end. */
  useEffect(() => {
    let cancelled = false;
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
  }, [companyId, poll, consume]);

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
        if (await consume(status)) return;

        // Only ever move forward. While verifying, `awaiting_code` is the
        // expected steady state — it is not a reason to show the form again.
        const current = uiRef.current;
        if (current.view === "starting" && status.authorizationUrl) {
          setUi({ view: "authorize", url: status.authorizationUrl, code: "" });
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
          <StatusBadge {...badgeFor(ui)} />
        </div>
        <p style={{ margin: 0, opacity: 0.75 }}>
          Signs your agents in to Claude for a year. You will need the Claude account that
          owns the subscription.
        </p>
      </header>

      {ui.view === "loading" && <Spinner size="sm" label="Checking sign-in state" />}

      {ui.view === "idle" && (
        <div>
          <button type="button" onClick={onStart}>
            Sign in to Claude
          </button>
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
            <a
              href={ui.url}
              target="_blank"
              rel="noreferrer noopener"
              style={{ fontWeight: 600 }}
            >
              Open Claude and approve the sign-in ↗
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
                style={{ padding: "8px 10px", width: "100%" }}
              />
              {ui.error && (
                <p role="alert" style={{ margin: 0, color: "var(--destructive, #f87171)" }}>
                  {ui.error}
                </p>
              )}
              <Row>
                <button type="button" onClick={onSubmit} disabled={!ui.code.trim()}>
                  Finish sign-in
                </button>
                <button type="button" onClick={onCancel}>
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
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {ui.view === "storing" && (
        <Row>
          <Spinner size="sm" label="Storing token" />
          <span>Storing your token…</span>
        </Row>
      )}

      {ui.view === "done" && (
        <div style={{ display: "grid", gap: 10 }}>
          <p style={{ margin: 0 }}>{ui.message}</p>
          <div>
            <button type="button" onClick={() => setUi({ view: "idle" })}>
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
            <button type="button" onClick={onStart}>
              Start again
            </button>
          </div>
        </div>
      )}
    </section>
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

function badgeFor(ui: Ui): { label: string; status: "ok" | "warning" | "error" | "info" | "pending" } {
  switch (ui.view) {
    case "loading":
      return { label: "Checking", status: "pending" };
    case "idle":
      return { label: "Not started", status: "info" };
    case "done":
      return { label: "Signed in", status: "ok" };
    case "error":
      return { label: "Failed", status: "error" };
    default:
      return { label: "In progress", status: "pending" };
  }
}

export default ClaudeAuthSettingsPage;
