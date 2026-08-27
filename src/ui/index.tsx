/**
 * The whole point of this plugin: a sign-in a non-technical person can finish.
 *
 * No terminal, ever. The pseudo-terminal exists in the worker; what reaches
 * this component is a phase, a URL to click, and one field to paste into.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import type { PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import { storeTokenSecret, TOKEN_SECRET_KEY } from "./secrets.js";

type Status = {
  state: "idle" | "starting" | "awaiting_authorization" | "awaiting_code" | "succeeded" | "failed";
  authorizationUrl?: string;
  reason?: string;
  token?: string;
};

type Ui =
  | { view: "idle" }
  | { view: "working"; message: string }
  | { view: "authorize"; url: string; code: string; busy: boolean; error?: string }
  | { view: "done"; message: string }
  | { view: "error"; message: string };

const POLL_INTERVAL_MS = 1200;

export function ClaudeAuthSettingsPage({ context }: PluginWidgetProps) {
  // Every call is company-scoped, so without a company there is nothing to do.
  if (!context.companyId) {
    return <p>Select a company to manage its Claude sign-in.</p>;
  }
  return <ClaudeAuthSettings companyId={context.companyId} />;
}

function ClaudeAuthSettings({ companyId }: { companyId: string }) {
  const start = usePluginAction("start");
  const poll = usePluginAction("poll");
  const submitCode = usePluginAction("submit-code");
  const cancel = usePluginAction("cancel");

  const [ui, setUi] = useState<Ui>({ view: "idle" });
  const polling = useRef(false);

  /**
   * The token arrives exactly once, in the reply to the poll that observes
   * success — the worker forgets it immediately afterwards. So it is stored
   * here, in the same tick it arrives, and never held in component state.
   */
  const consume = useCallback(
    async (status: Status): Promise<boolean> => {
      if (status.state === "succeeded") {
        if (!status.token) {
          setUi({
            view: "error",
            message: "The sign-in finished but no token arrived. Please try again.",
          });
          return true;
        }
        setUi({ view: "working", message: "Storing your token…" });
        try {
          const outcome = await storeTokenSecret(companyId, status.token);
          setUi({
            view: "done",
            message:
              outcome.action === "rotated"
                ? `Signed in. ${TOKEN_SECRET_KEY} was updated and is valid for a year.`
                : `Signed in. ${TOKEN_SECRET_KEY} was created and is valid for a year.`,
          });
        } catch (error) {
          setUi({
            view: "error",
            message: `Signed in, but the token could not be saved: ${
              error instanceof Error ? error.message : String(error)
            }. The token cannot be shown again — please sign in once more.`,
          });
        }
        return true;
      }
      if (status.state === "failed") {
        setUi({ view: "error", message: status.reason ?? "The sign-in failed." });
        return true;
      }
      return false;
    },
    [companyId],
  );

  // Poll while a sign-in is live. Stops on any terminal state.
  useEffect(() => {
    if (ui.view !== "working" && ui.view !== "authorize") return;
    if (polling.current) return;
    polling.current = true;

    let cancelled = false;
    const tick = async () => {
      while (!cancelled) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        if (cancelled) break;
        try {
          const status = (await poll({ companyId })) as Status;
          if (await consume(status)) break;
          if (status.authorizationUrl) {
            setUi((current) =>
              current.view === "authorize"
                ? { ...current, url: status.authorizationUrl! }
                : { view: "authorize", url: status.authorizationUrl!, code: "", busy: false },
            );
          }
        } catch (error) {
          setUi({
            view: "error",
            message: error instanceof Error ? error.message : String(error),
          });
          break;
        }
      }
      polling.current = false;
    };
    void tick();
    return () => {
      cancelled = true;
    };
  }, [ui.view, poll, companyId, consume]);

  const onStart = async () => {
    setUi({ view: "working", message: "Preparing your sign-in link…" });
    try {
      const status = (await start({ companyId })) as Status;
      if (await consume(status)) return;
      if (status.authorizationUrl) {
        setUi({ view: "authorize", url: status.authorizationUrl, code: "", busy: false });
      }
    } catch (error) {
      setUi({ view: "error", message: error instanceof Error ? error.message : String(error) });
    }
  };

  const onSubmit = async () => {
    if (ui.view !== "authorize" || !ui.code.trim()) return;
    setUi({ ...ui, busy: true, error: undefined });
    try {
      await submitCode({ companyId, code: ui.code.trim() });
      setUi({ view: "working", message: "Checking your code…" });
    } catch (error) {
      // Claude says nothing about a bad code, so this message comes from our
      // own check against the sign-in's state.
      setUi({
        ...ui,
        busy: false,
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

  return (
    <div style={{ maxWidth: 560, display: "grid", gap: 16 }}>
      <header>
        <h2 style={{ margin: 0 }}>Claude sign-in</h2>
        <p style={{ margin: "4px 0 0", opacity: 0.75 }}>
          Signs your agents in to Claude for a year. You will need the Claude account that
          owns the subscription.
        </p>
      </header>

      {ui.view === "idle" && (
        <button type="button" onClick={onStart}>
          Sign in to Claude
        </button>
      )}

      {ui.view === "working" && <p>{ui.message}</p>}

      {ui.view === "authorize" && (
        <div style={{ display: "grid", gap: 12 }}>
          <ol style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 8 }}>
            <li>
              <a href={ui.url} target="_blank" rel="noreferrer noopener">
                Open Claude and approve the sign-in
              </a>
            </li>
            <li>Copy the code Claude gives you and paste it below.</li>
          </ol>
          <input
            type="text"
            value={ui.code}
            placeholder="Paste the code from Claude"
            autoComplete="off"
            spellCheck={false}
            disabled={ui.busy}
            onChange={(event) => setUi({ ...ui, code: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") void onSubmit();
            }}
          />
          {ui.error && <p role="alert">{ui.error}</p>}
          <div style={{ display: "flex", gap: 8 }}>
            <button type="button" onClick={onSubmit} disabled={ui.busy || !ui.code.trim()}>
              {ui.busy ? "Checking…" : "Finish sign-in"}
            </button>
            <button type="button" onClick={onCancel} disabled={ui.busy}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {ui.view === "done" && (
        <div>
          <p>{ui.message}</p>
          <button type="button" onClick={() => setUi({ view: "idle" })}>
            Done
          </button>
        </div>
      )}

      {ui.view === "error" && (
        <div>
          <p role="alert">{ui.message}</p>
          <button type="button" onClick={onStart}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

export default ClaudeAuthSettingsPage;
