/**
 * Self-update, through the host's own API.
 *
 * Paperclip implements plugin upgrade fully — `POST /api/plugins/:id/upgrade`
 * deactivates the runtime, downloads and validates the new package, diffs the
 * manifest capabilities, and either parks the plugin in `upgrade_pending` for
 * operator approval or transitions it back to ready and reactivates. What is
 * missing is any UI that calls it: `pluginsApi.upgrade()` exists in the host's
 * own client and has zero callers, so an installed plugin cannot be updated
 * from the product at all.
 *
 * Until that button exists upstream, this plugin ships its own. The worker
 * deliberately does not do this: plugin UI runs same-origin inside the
 * Paperclip app with the board session, so the upgrade happens as the signed-in
 * human under that human's own permissions — the same route this plugin's UI
 * already uses for secret writes. A worker-side upgrade would instead be the
 * plugin escalating itself, which is a different and much worse thing.
 */

/** The npm package this plugin is published as. */
export const PACKAGE_NAME = "paperclip-claude-auth";

interface PluginRecord {
  id: string;
  pluginKey: string;
  packageName: string;
  version: string;
  status: string;
  /** Set only for a local-folder install; null for a registry (npm) install. */
  packagePath?: string | null;
}

export interface SelfInfo {
  id: string;
  installedVersion: string;
  status: string;
  /** Absent when the registry could not be reached — an air-gapped instance is
   *  not an error state, it just cannot be told whether an update exists. */
  latestVersion?: string;
  updateAvailable: boolean;
  /**
   * Set when the plugin was installed from a folder on the server. The host's
   * upgrade then re-reads that folder and never contacts npm, so the panel must
   * not promise a registry update it cannot deliver.
   */
  localPath?: string;
}

async function json<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const text = await response.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error pages fall through to the status check below */
  }
  if (!response.ok) {
    const message =
      (body as { error?: string } | null)?.error ||
      (response.status === 403
        ? "Updating a plugin requires an instance administrator."
        : `The request failed (${response.status}).`);
    throw new Error(message);
  }
  return body as T;
}

/** Compare two semvers. Returns true when `candidate` is newer than `current`. */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (value: string): number[] =>
    value
      .replace(/^v/, "")
      .split("-")[0]!
      .split(".")
      .map((part) => Number.parseInt(part, 10) || 0);
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}

/**
 * Find this plugin's own installation record.
 *
 * (Shared with paperclip-hermes-codex-auth; keep the two copies in step.)
 *
 * There is no `pluginId` in the host context, so the plugin has to recognise
 * itself. `packageName` is matched first because it is what an npm upgrade
 * actually resolves; `pluginKey` is the fallback for a local-path install,
 * where the package name may be a directory.
 */
export async function findSelf(): Promise<SelfInfo> {
  const payload = await json<{ plugins?: PluginRecord[] } | PluginRecord[]>("/api/plugins");
  const plugins = Array.isArray(payload) ? payload : (payload.plugins ?? []);
  const self =
    plugins.find((p) => p.packageName === PACKAGE_NAME) ??
    plugins.find((p) => p.packageName?.endsWith(PACKAGE_NAME)) ??
    plugins.find((p) => p.pluginKey === "ordillect.claude-auth");
  if (!self) throw new Error("Could not find this plugin's own installation record.");

  const localPath = self.packagePath || undefined;

  let latestVersion: string | undefined;
  try {
    const meta = await fetch(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, {
      headers: { Accept: "application/json" },
    });
    if (meta.ok) latestVersion = ((await meta.json()) as { version?: string }).version;
  } catch {
    // Offline or blocked egress. Leave `latestVersion` undefined and let the UI
    // offer the update anyway rather than claim the plugin is up to date.
  }

  return {
    id: self.id,
    installedVersion: self.version,
    status: self.status,
    latestVersion,
    updateAvailable: !localPath && latestVersion ? isNewer(latestVersion, self.version) : false,
    localPath,
  };
}

export type UpgradeOutcome =
  | { kind: "upgraded"; version: string }
  | { kind: "approval_required" }
  | { kind: "unchanged"; version: string };

/**
 * Ask the host to upgrade this plugin.
 *
 * Omitting `version` takes the latest the registry offers. A response of
 * `upgrade_pending` means the new manifest requests capabilities the installed
 * one did not, and the host is holding it for an operator decision — that is
 * the gate working, not a failure, so it is reported as its own outcome.
 */
export async function upgradeSelf(
  self: Pick<SelfInfo, "id" | "installedVersion">,
  version?: string,
): Promise<UpgradeOutcome> {
  const result = await json<{ status?: string; version?: string }>(
    `/api/plugins/${self.id}/upgrade`,
    { method: "POST", body: JSON.stringify(version ? { version } : {}) },
  );
  if (result?.status === "upgrade_pending") return { kind: "approval_required" };
  const next = result?.version ?? "";
  // The host reports success even when it reinstalled the version already
  // running. Calling that "Updated" would be a lie the user acts on.
  if (next && next === self.installedVersion) return { kind: "unchanged", version: next };
  return { kind: "upgraded", version: next };
}
