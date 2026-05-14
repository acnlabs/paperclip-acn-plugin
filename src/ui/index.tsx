import React, { useState } from "react";
import {
  usePluginAction,
  usePluginData,
  type PluginDetailTabProps,
} from "@paperclipai/plugin-sdk/ui";

// ── Types shared with worker bridge ──────────────────────────────────────────

export interface AcnTaskInfo {
  task_id: string;
  title: string;
  status: string;
  /** Decimal string from ACN backend (e.g. "10.00"). */
  reward: string;
  reward_currency: string;
  participations: Array<{
    participation_id: string;
    agent_id: string;
    status: string;
    submission_content: string | null;
    submitted_at: string | null;
    resubmit_count: number;
  }>;
}

// ── Minimal inline styles (no Tailwind dependency) ────────────────────────────

const styles = {
  container: {
    padding: "16px",
    fontFamily: "inherit",
    fontSize: "13px",
    color: "var(--color-fg-default, #1a1a1a)",
  } as React.CSSProperties,

  row: {
    display: "flex",
    gap: "8px",
    alignItems: "baseline",
    marginBottom: "6px",
  } as React.CSSProperties,

  label: {
    fontWeight: 600,
    color: "var(--color-fg-muted, #666)",
    minWidth: "100px",
    flexShrink: 0,
  } as React.CSSProperties,

  badge: (color: string): React.CSSProperties => ({
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: "12px",
    fontSize: "11px",
    fontWeight: 600,
    background: color,
    color: "#fff",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  }),

  section: {
    marginTop: "16px",
    borderTop: "1px solid var(--color-border-default, #e5e5e5)",
    paddingTop: "12px",
  } as React.CSSProperties,

  sectionTitle: {
    fontWeight: 700,
    marginBottom: "8px",
    fontSize: "12px",
    textTransform: "uppercase",
    letterSpacing: "0.06em",
    color: "var(--color-fg-muted, #888)",
  } as React.CSSProperties,

  participationCard: {
    background: "var(--color-bg-subtle, #f6f6f6)",
    borderRadius: "6px",
    padding: "10px 12px",
    marginBottom: "8px",
  } as React.CSSProperties,

  pre: {
    background: "var(--color-bg-subtle, #f0f0f0)",
    borderRadius: "4px",
    padding: "8px",
    fontSize: "12px",
    overflowX: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    marginTop: "6px",
  } as React.CSSProperties,

  actionRow: {
    display: "flex",
    gap: "8px",
    marginTop: "16px",
  } as React.CSSProperties,

  btn: (variant: "approve" | "reject" | "neutral"): React.CSSProperties => ({
    padding: "6px 16px",
    borderRadius: "6px",
    border: "none",
    cursor: "pointer",
    fontWeight: 600,
    fontSize: "13px",
    background:
      variant === "approve"
        ? "#16a34a"
        : variant === "reject"
          ? "#dc2626"
          : "var(--color-bg-subtle, #e5e5e5)",
    color: variant === "neutral" ? "var(--color-fg-default, #333)" : "#fff",
    opacity: 1,
    transition: "opacity 0.15s",
  }),

  textarea: {
    width: "100%",
    minHeight: "64px",
    borderRadius: "6px",
    border: "1px solid var(--color-border-default, #ccc)",
    padding: "6px 8px",
    fontSize: "12px",
    fontFamily: "inherit",
    resize: "vertical",
    boxSizing: "border-box",
    marginTop: "8px",
  } as React.CSSProperties,

  muted: {
    color: "var(--color-fg-muted, #888)",
    fontSize: "12px",
  } as React.CSSProperties,

  mono: {
    fontFamily: "monospace",
    fontSize: "11px",
    background: "var(--color-bg-subtle, #f0f0f0)",
    padding: "1px 5px",
    borderRadius: "3px",
  } as React.CSSProperties,
} as const;

// ── Status badge ──────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  open: "#2563eb",
  in_progress: "#d97706",
  in_review: "#7c3aed",
  completed: "#16a34a",
  cancelled: "#6b7280",
  rejected: "#dc2626",
  submitted: "#7c3aed",
  accepted: "#d97706",
};

function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? "#6b7280";
  return <span style={styles.badge(color)}>{status.replace(/_/g, " ")}</span>;
}

// ── Participation item ────────────────────────────────────────────────────────

function ParticipationItem({
  p,
}: {
  p: AcnTaskInfo["participations"][number];
}) {
  const [expanded, setExpanded] = useState(false);
  const hasSubmission = Boolean(p.submission_content);

  return (
    <div style={styles.participationCard}>
      <div style={styles.row}>
        <span style={styles.label}>Agent</span>
        <span style={styles.mono}>{p.agent_id}</span>
      </div>
      <div style={styles.row}>
        <span style={styles.label}>Status</span>
        <StatusBadge status={p.status} />
        {p.resubmit_count > 0 && (
          <span style={styles.muted}>({p.resubmit_count} resubmit{p.resubmit_count > 1 ? "s" : ""})</span>
        )}
      </div>
      {p.submitted_at && (
        <div style={styles.row}>
          <span style={styles.label}>Submitted</span>
          <span style={styles.muted}>{new Date(p.submitted_at).toLocaleString()}</span>
        </div>
      )}
      {hasSubmission && (
        <>
          <button
            type="button"
            style={{ ...styles.btn("neutral"), marginTop: "6px", fontSize: "11px", padding: "3px 10px" }}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? "Hide submission" : "Show submission"}
          </button>
          {expanded && <pre style={styles.pre}>{p.submission_content}</pre>}
        </>
      )}
    </div>
  );
}

// ── Review panel ──────────────────────────────────────────────────────────────

function ReviewPanel({
  taskId,
  onDone,
}: {
  taskId: string;
  onDone: () => void;
}) {
  const [feedback, setFeedback] = useState("");
  const [pending, setPending] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const review = usePluginAction("acn-review");

  async function handleReview(approved: boolean) {
    const action = approved ? "approve" : "reject";
    setPending(action);
    setError(null);
    try {
      await review({ taskId, approved, feedback: feedback.trim() || undefined });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Review failed");
    } finally {
      setPending(null);
    }
  }

  return (
    <div style={styles.section}>
      <div style={styles.sectionTitle}>Review Submission</div>
      <textarea
        style={styles.textarea}
        placeholder="Optional feedback…"
        value={feedback}
        onChange={(e) => setFeedback(e.target.value)}
        disabled={pending !== null}
      />
      {error && <div style={{ color: "#dc2626", fontSize: "12px", marginTop: "4px" }}>{error}</div>}
      <div style={styles.actionRow}>
        <button
          type="button"
          style={{ ...styles.btn("approve"), opacity: pending ? 0.6 : 1 }}
          disabled={pending !== null}
          onClick={() => void handleReview(true)}
        >
          {pending === "approve" ? "Approving…" : "Approve"}
        </button>
        <button
          type="button"
          style={{ ...styles.btn("reject"), opacity: pending ? 0.6 : 1 }}
          disabled={pending !== null}
          onClick={() => void handleReview(false)}
        >
          {pending === "reject" ? "Rejecting…" : "Reject"}
        </button>
      </div>
    </div>
  );
}

// ── Main ACN Issue Tab ────────────────────────────────────────────────────────

export function ACNIssueTab({ context }: PluginDetailTabProps) {
  const issueId = context.entityId;
  const companyId = context.companyId;
  const [reviewDone, setReviewDone] = useState(false);

  const { data, loading, error } = usePluginData<AcnTaskInfo | null>(
    "acn-task-info",
    issueId && companyId ? { issueId, companyId } : {},
  );

  if (!issueId) {
    return <div style={styles.container}><span style={styles.muted}>No issue selected.</span></div>;
  }

  if (loading) {
    return <div style={styles.container}><span style={styles.muted}>Loading…</span></div>;
  }

  if (error) {
    return (
      <div style={styles.container}>
        <span style={{ color: "#dc2626" }}>Failed to load ACN data: {error.message}</span>
      </div>
    );
  }

  if (!data) {
    return (
      <div style={styles.container}>
        <span style={styles.muted}>This issue is not linked to an ACN task.</span>
      </div>
    );
  }

  const submittedParticipation = data.participations.find(
    (p) => p.status === "submitted",
  );
  const canReview = !reviewDone && Boolean(submittedParticipation);

  return (
    <div style={styles.container}>
      {/* Task meta */}
      <div style={styles.row}>
        <span style={styles.label}>ACN Task</span>
        <span style={styles.mono}>{data.task_id}</span>
      </div>
      <div style={styles.row}>
        <span style={styles.label}>Status</span>
        <StatusBadge status={data.status} />
      </div>
      {parseFloat(data.reward ?? "0") > 0 && (
        <div style={styles.row}>
          <span style={styles.label}>Reward</span>
          <span>{data.reward} {data.reward_currency}</span>
        </div>
      )}

      {/* Participations */}
      {data.participations.length > 0 && (
        <div style={styles.section}>
          <div style={styles.sectionTitle}>
            Participants ({data.participations.length})
          </div>
          {data.participations.map((p) => (
            <ParticipationItem key={p.participation_id} p={p} />
          ))}
        </div>
      )}

      {/* Review panel — shown when there is a pending submission */}
      {canReview && (
        <ReviewPanel
          taskId={data.task_id}
          onDone={() => {
            setReviewDone(true);
            setTimeout(() => setReviewDone(false), 3000);
          }}
        />
      )}

      {reviewDone && (
        <div style={{ ...styles.section, color: "#16a34a", fontWeight: 600 }}>
          Review submitted. ACN will process the result.
        </div>
      )}
    </div>
  );
}
