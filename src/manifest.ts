import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  EXPORT_NAMES,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SLOT_IDS,
  WEBHOOK_KEYS,
} from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "ACN — Agent Collaboration Network",
  description:
    "Connect Paperclip to ACN: sync tasks, manage agent identity, and settle work through the ACN protocol layer.",
  author: "acnlabs",
  categories: ["connector", "automation"],

  entrypoints: {
    worker: "dist/worker.js",
    ui: "dist/ui",
  },

  capabilities: [
    "companies.read",
    "issues.read",
    "issues.create",
    "issues.update",
    "issue.comments.read",
    "issue.comments.create",
    "agents.read",
    "events.subscribe",
    "webhooks.receive",
    "http.outbound",
    "secrets.read-ref",
    "plugin.state.read",
    "plugin.state.write",
    "ui.detailTab.register",
    "instance.settings.register",
  ],

  instanceConfigSchema: {
    type: "object",
    properties: {
      acnBaseUrl: {
        type: "string",
        title: "ACN Base URL",
        default: "https://acn.agentplanet.io",
        description: "Base URL of the ACN instance (no trailing slash).",
      },
      paperclipBaseUrl: {
        type: "string",
        title: "Paperclip Base URL",
        default: "",
        description:
          "Public base URL of this Paperclip instance (e.g. https://app.paperclip.ai). Used to construct the ACN harness webhook URL.",
      },
      acnApiKeyRef: {
        type: "string",
        title: "ACN API Key (secret ref)",
        default: "",
        description:
          "Secret reference to the ACN agent API key used to call ACN on behalf of Paperclip.",
      },
      acnHarnessSecretRef: {
        type: "string",
        title: "ACN Harness Webhook Secret (secret ref)",
        default: "",
        description:
          "Secret reference to the shared HMAC-SHA256 secret used to sign and verify ACN harness webhook deliveries (X-ACN-Signature). Leave blank to skip verification (NOT recommended in production).",
      },
      acnSubnetId: {
        type: "string",
        title: "ACN Subnet ID",
        default: "",
        description:
          "The ACN subnet whose tasks this plugin syncs into Paperclip issues.",
      },
      autoCreateIssues: {
        type: "boolean",
        title: "Auto-create Paperclip issues for new ACN tasks",
        default: true,
      },
      autoApproveOnDone: {
        type: "boolean",
        title: "Auto-approve ACN task when Paperclip issue moves to 'done'",
        default: false,
        description:
          "When disabled, a board member must click Approve in the ACN tab to release payment.",
      },
    },
  },

  webhooks: [
    {
      endpointKey: WEBHOOK_KEYS.acnEvents,
      displayName: "ACN Task Events",
      description:
        "Receives HMAC-signed lifecycle events from ACN (task.created, task.submitted, task.completed, ...).",
    },
  ],

  ui: {
    slots: [
      {
        type: "detailTab",
        id: SLOT_IDS.issueTab,
        displayName: "ACN",
        exportName: EXPORT_NAMES.issueTab,
        entityTypes: ["issue"],
      },
    ],
  },
};

export default manifest;
