export const PLUGIN_ID = "acnlabs.acn";
export const PLUGIN_VERSION = "0.1.0";

export const WEBHOOK_KEYS = {
  acnEvents: "acn-events",
} as const;

export const SLOT_IDS = {
  issueTab: "acn-issue-tab",
} as const;

export const EXPORT_NAMES = {
  issueTab: "ACNIssueTab",
} as const;

/** Plugin state keys. State is company-scoped (see `loadMap`/`saveMap`). */
export const STATE_KEYS = {
  /** Map of ACN taskId → Paperclip issueId. */
  issueTaskMap: "issue-task-map",
} as const;
