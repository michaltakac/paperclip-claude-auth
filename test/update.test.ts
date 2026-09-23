import { afterEach, describe, expect, it, vi } from "vitest";
import { findSelf, isNewer, PACKAGE_NAME, upgradeSelf } from "../src/ui/update.js";

describe("isNewer", () => {
  it("recognises an ordinary bump", () => {
    expect(isNewer("1.0.1", "1.0.0")).toBe(true);
    expect(isNewer("1.1.0", "1.0.9")).toBe(true);
    expect(isNewer("2.0.0", "1.9.9")).toBe(true);
  });

  it("does not offer an update to the version already installed", () => {
    expect(isNewer("1.0.1", "1.0.1")).toBe(false);
  });

  it("does not offer a downgrade", () => {
    expect(isNewer("1.0.0", "1.0.1")).toBe(false);
    // 10 > 9 numerically, but a string compare would say otherwise.
    expect(isNewer("1.0.9", "1.0.10")).toBe(false);
  });

  it("compares numerically, not lexically", () => {
    expect(isNewer("1.0.10", "1.0.9")).toBe(true);
    expect(isNewer("1.10.0", "1.9.0")).toBe(true);
  });

  it("tolerates a leading v and a prerelease suffix", () => {
    expect(isNewer("v1.0.2", "1.0.1")).toBe(true);
    expect(isNewer("1.0.2-beta.1", "1.0.1")).toBe(true);
  });

  it("treats a missing segment as zero", () => {
    expect(isNewer("1.1", "1.0.9")).toBe(true);
    expect(isNewer("1.0", "1.0.0")).toBe(false);
  });
});

describe("PACKAGE_NAME", () => {
  it("matches what the plugin is published as, since upgrade resolves by it", () => {
    expect(PACKAGE_NAME).toBe("paperclip-claude-auth");
  });
});

function stubFetch(routes: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const body = routes[url];
      if (body === undefined) return new Response("not found", { status: 404 });
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

describe("findSelf", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("offers an npm update for a registry install", async () => {
    stubFetch({
      "/api/plugins": [{ id: "p1", pluginKey: "k", packageName: PACKAGE_NAME, version: "1.0.0", status: "ready", packagePath: null }],
      [`https://registry.npmjs.org/${PACKAGE_NAME}/latest`]: { version: "1.2.0" },
    });
    const self = await findSelf();
    expect(self.updateAvailable).toBe(true);
    expect(self.localPath).toBeUndefined();
  });

  it("does not promise an npm update to a local-folder install", async () => {
    // The host's upgrade re-reads the folder and never contacts npm.
    stubFetch({
      "/api/plugins": [{ id: "p1", pluginKey: "k", packageName: PACKAGE_NAME, version: "1.0.0", status: "ready", packagePath: "/paperclip/plugin-src/paperclip-claude-auth" }],
      [`https://registry.npmjs.org/${PACKAGE_NAME}/latest`]: { version: "1.2.0" },
    });
    const self = await findSelf();
    expect(self.updateAvailable).toBe(false);
    expect(self.localPath).toBe("/paperclip/plugin-src/paperclip-claude-auth");
  });
});

describe("upgradeSelf", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("reports a reinstall of the running version as unchanged, not updated", async () => {
    stubFetch({ "/api/plugins/p1/upgrade": { status: "ready", version: "1.0.0" } });
    await expect(upgradeSelf({ id: "p1", installedVersion: "1.0.0" })).resolves.toEqual({
      kind: "unchanged",
      version: "1.0.0",
    });
  });

  it("reports a held upgrade as needing approval", async () => {
    stubFetch({ "/api/plugins/p1/upgrade": { status: "upgrade_pending", version: "1.2.0" } });
    await expect(upgradeSelf({ id: "p1", installedVersion: "1.0.0" })).resolves.toEqual({
      kind: "approval_required",
    });
  });

  it("reports a real upgrade", async () => {
    stubFetch({ "/api/plugins/p1/upgrade": { status: "ready", version: "1.2.0" } });
    await expect(upgradeSelf({ id: "p1", installedVersion: "1.0.0" })).resolves.toEqual({
      kind: "upgraded",
      version: "1.2.0",
    });
  });
});
