import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

export const SLOT_IDS = {
  settingsPage: "claude-auth-settings-page",
} as const;

export const EXPORT_NAMES = {
  settingsPage: "ClaudeAuthSettingsPage",
} as const;

export const ACTIONS = {
  status: "status",
  start: "start",
  poll: "poll",
  submitCode: "submit-code",
  cancel: "cancel",
  diagnostics: "diagnostics",
} as const;

/**
 * `local.folders` is deliberately absent. The token reaches the adapter as a
 * company secret written through the host's own API by the signed-in human, so
 * the worker needs no filesystem access at all — see DESIGN.md.
 */
const manifest: PaperclipPluginManifestV1 = {
  id: "ordillect.claude-auth",
  apiVersion: 1,
  version: "1.0.1",
  displayName: "Claude Sign-in",
  description:
    "Sign in to Claude from the Paperclip UI. Runs `claude setup-token` in the background and binds the resulting 1-year token as the CLAUDE_CODE_OAUTH_TOKEN company secret. Works on local environments.",
  author: "Michal Takáč <hello@michaltakac.com>",
  categories: ["workspace"],
  capabilities: [
    // A `settingsPage` slot maps to `instance.settings.register`, not
    // `ui.page.register` — see UI_SLOT_CAPABILITIES in the host's
    // plugin-capability-validator.
    "instance.settings.register",
    "ui.action.register",
    "plugin.state.read",
    "plugin.state.write",
    "activity.log.write",
  ],
  entrypoints: {
    worker: "dist/worker.js",
    ui: "dist/ui/",
  },
  instanceConfigSchema: {
    type: "object",
    properties: {
      claudePath: {
        type: "string",
        title: "Path to the Claude CLI",
        description:
          "Absolute path to the `claude` executable inside the Paperclip runtime.",
        default: "/usr/local/bin/claude",
      },
      claudeHome: {
        type: "string",
        title: "Claude home",
        description:
          "HOME for the sign-in process. Defaults to the runtime's PAPERCLIP_HOME.",
        default: "",
      },
      scriptPath: {
        type: "string",
        title: "Path to `script`",
        description:
          "util-linux `script`, used to allocate the pseudo-terminal that `claude setup-token` requires.",
        default: "/usr/bin/script",
      },
    },
  },
  ui: {
    slots: [
      {
        type: "settingsPage",
        id: SLOT_IDS.settingsPage,
        displayName: "Claude Sign-in",
        exportName: EXPORT_NAMES.settingsPage,
      },
    ],
  },
};

export default manifest;
