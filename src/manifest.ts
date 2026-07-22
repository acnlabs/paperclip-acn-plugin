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
    "Connect Paperclip to ACN Org Harness: issues → Org work, identity/fencing via subnet, optional legacy Task mirror inbound.",
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
        default: "https://api.acnlabs.dev",
        description:
          "Base URL of the ACN instance (no trailing slash). Defaults to ACN Labs' hosted production ACN — point at your own deployment to self-host.",
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
      acnOrgId: {
        type: "string",
        title: "ACN Org ID",
        default: "",
        description:
          "Existing Org Harness org_id (org_…). If empty, the plugin creates one bound to ACN Subnet ID on first setup and stores it in plugin state.",
      },
      acnSubnetId: {
        type: "string",
        title: "ACN Subnet ID",
        default: "",
        description:
          "Fence subnet for harness webhooks. Required when ACN Org ID is empty (used to create/bind the Org). Prefer the Org's fence subnet.",
      },
      autoCreateIssues: {
        type: "boolean",
        title: "Auto-create Paperclip issues for new ACN tasks (legacy)",
        default: true,
        description:
          "Inbound task.* → Issue mirror. Outbound Issue create now writes Org work (not Task Pool).",
      },
      autoApproveOnDone: {
        type: "boolean",
        title: "Sync 'done' to ACN when Paperclip issue completes",
        default: false,
        description:
          "When true: Org-mapped issues PATCH work status to done; legacy Task-mirrored issues call /review approve. Cancelled always syncs.",
      },
    },
  },

  webhooks: [
    {
      endpointKey: WEBHOOK_KEYS.acnEvents,
      displayName: "ACN Harness Events",
      description:
        "Receives HMAC-signed lifecycle events from ACN (org.work_* / org.loop_tick preferred; task.* legacy).",
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
