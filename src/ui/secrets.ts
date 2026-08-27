/**
 * Company-scoped secret writes, through the host's own API.
 *
 * The worker deliberately does not do this. `PluginSecretsClient` is read-only,
 * and plugin UI runs same-origin inside the Paperclip app with the board
 * session — so the write happens as the signed-in human, under that human's own
 * permissions, on supported endpoints. See DESIGN.md.
 *
 * Update is a **rotate**, not a create: `POST /api/secrets/:id/rotate` replaces
 * the value in place and keeps version history, which is what you want for a
 * credential that will be renewed once a year.
 */

/** The env var the `claude_local` adapter reads. */
export const TOKEN_SECRET_KEY = "CLAUDE_CODE_OAUTH_TOKEN";

const SECRET_NAME = "Claude Code OAuth token";
const SECRET_DESCRIPTION =
  "Long-lived (1-year) Claude subscription token minted by `claude setup-token`. Managed by the Claude Sign-in plugin.";

interface CompanySecret {
  id: string;
  key?: string | null;
  name?: string | null;
  status?: string | null;
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

/** The existing, non-deleted company secret for the token, if there is one. */
export async function findTokenSecret(companyId: string): Promise<CompanySecret | null> {
  const secrets = await request<CompanySecret[]>(
    `/api/companies/${encodeURIComponent(companyId)}/secrets`,
  );
  const match = secrets.find(
    (secret) => secret.key === TOKEN_SECRET_KEY && secret.status !== "deleted",
  );
  return match ?? null;
}

export type StoreOutcome = { action: "created" | "rotated"; id: string };

/**
 * Store the token, updating in place when it already exists.
 *
 * The caller must drop the token immediately afterwards — `setup-token` prints
 * it exactly once and it cannot be retrieved again.
 */
export async function storeTokenSecret(
  companyId: string,
  token: string,
): Promise<StoreOutcome> {
  const existing = await findTokenSecret(companyId);

  if (existing) {
    await request(`/api/secrets/${encodeURIComponent(existing.id)}/rotate`, {
      method: "POST",
      body: JSON.stringify({ value: token }),
    });
    return { action: "rotated", id: existing.id };
  }

  const created = await request<{ id: string }>(
    `/api/companies/${encodeURIComponent(companyId)}/secrets`,
    {
      method: "POST",
      body: JSON.stringify({
        name: SECRET_NAME,
        key: TOKEN_SECRET_KEY,
        value: token,
        description: SECRET_DESCRIPTION,
      }),
    },
  );
  return { action: "created", id: created.id };
}
