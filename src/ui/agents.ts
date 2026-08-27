/**
 * Binding the stored token into agent environments.
 *
 * Creating the secret is only half the job: a secret with no bindings reaches
 * no agent, so a user can be told "signed in" and still have every agent fail.
 * This closes that gap.
 *
 * Like the secret write, it runs from the UI against the host's own API as the
 * signed-in human — `PluginAgentsClient` has no config write, and this is
 * better authorization anyway.
 */

import { TOKEN_SECRET_KEY } from "./secrets.js";

/** Only agents on this adapter consume a Claude subscription token. */
export const CLAUDE_ADAPTER = "claude_local";

interface AgentRecord {
  id: string;
  name?: string | null;
  adapterType?: string | null;
  adapterConfig?: Record<string, unknown> | null;
}

export interface BindOutcome {
  /** Agents that now receive the token. */
  bound: string[];
  /** Agents left alone because they already had a binding. */
  alreadyBound: string[];
  /** Agents that could not be updated, with the reason. */
  failed: { name: string; reason: string }[];
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    let message = `${response.status} ${response.statusText}`;
    try {
      const parsed = JSON.parse(body) as { error?: string; message?: string };
      message = parsed.error ?? parsed.message ?? message;
    } catch {
      if (body) message = body.slice(0, 200);
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

/** An env map already carries this key, whatever its casing. */
function hasBinding(env: Record<string, unknown>, key: string): boolean {
  const wanted = key.toLowerCase();
  return Object.keys(env).some((name) => name.toLowerCase() === wanted);
}

/**
 * Bind the token to every Claude agent that does not already have one.
 *
 * Deliberately conservative: an agent with an existing `CLAUDE_CODE_OAUTH_TOKEN`
 * binding is left untouched, because that binding may be a deliberate
 * per-agent choice and silently overwriting it would be the kind of surprise
 * that erodes trust in an automated action.
 */
export async function bindTokenToAgents(
  companyId: string,
  secretId: string,
): Promise<BindOutcome> {
  const agents = await request<AgentRecord[]>(
    `/api/companies/${encodeURIComponent(companyId)}/agents`,
  );

  const outcome: BindOutcome = { bound: [], alreadyBound: [], failed: [] };
  const claudeAgents = agents.filter((agent) => agent.adapterType === CLAUDE_ADAPTER);

  for (const agent of claudeAgents) {
    const label = agent.name ?? agent.id;
    const adapterConfig = { ...(agent.adapterConfig ?? {}) } as Record<string, unknown>;
    const env = { ...((adapterConfig.env as Record<string, unknown>) ?? {}) };

    if (hasBinding(env, TOKEN_SECRET_KEY)) {
      outcome.alreadyBound.push(label);
      continue;
    }

    env[TOKEN_SECRET_KEY] = { type: "secret_ref", secretId };
    adapterConfig.env = env;

    try {
      // Send the whole adapterConfig, merged. A partial patch risks replacing
      // the object and dropping unrelated adapter settings such as the model.
      await request(`/api/agents/${encodeURIComponent(agent.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ adapterConfig }),
      });
      outcome.bound.push(label);
    } catch (error) {
      outcome.failed.push({
        name: label,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return outcome;
}

/** Human-readable summary of what the binding pass did. */
export function describeBindOutcome(outcome: BindOutcome): string {
  const parts: string[] = [];
  if (outcome.bound.length) {
    parts.push(
      `Connected ${outcome.bound.length} agent${outcome.bound.length === 1 ? "" : "s"}: ${outcome.bound.join(", ")}.`,
    );
  }
  if (outcome.alreadyBound.length) {
    parts.push(`${outcome.alreadyBound.length} already had a token and were left alone.`);
  }
  if (outcome.failed.length) {
    parts.push(
      `Could not update ${outcome.failed.map((f) => `${f.name} (${f.reason})`).join(", ")}.`,
    );
  }
  if (!parts.length) {
    parts.push("No Claude agents found to connect — add one and sign in again.");
  }
  return parts.join(" ");
}
