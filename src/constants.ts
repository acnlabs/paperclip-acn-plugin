export const PLUGIN_ID = "acnlabs.acn";
export const PLUGIN_VERSION = "0.3.2";

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
  /** Map of ACN taskId → Paperclip issueId (legacy Task Pool mirror). */
  issueTaskMap: "issue-task-map",
  /** Map of ACN workId → Paperclip issueId (Org Harness Work Port). */
  issueWorkMap: "issue-work-map",
  /** Persisted Org id when auto-created on setup (company-scoped string). */
  acnOrgId: "acn-org-id",
} as const;
