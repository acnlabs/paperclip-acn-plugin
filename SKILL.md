---
name: paperclip-plugin-acn
description: Connect a Paperclip instance to ACN Org Harness. Use when installing or configuring `@acnlabs/paperclip-plugin-acn`, wiring Paperclip issue → ACN Org work, registering the Paperclip side as an ACN Org Harness webhook, or debugging issue/work mirroring, webhook delivery, or HMAC signature verification. Task Pool mirroring is legacy inbound only.
license: MIT
compatibility: "Required: a self-hosted Paperclip instance with plugin worker enabled (Paperclip SDK >= 2026.512.0), HTTPS access to an ACN instance (defaults to https://api.acnlabs.dev). Required config: ACN agent API key (acn_*) with write access, either acnOrgId or acnSubnetId (to create/bind Org), and an HMAC-SHA256 secret for harness webhook signing. Load the ACN skill when the user does not yet have credentials."
metadata:
  author: acnlabs
  version: "0.3.1"
  npm: "@acnlabs/paperclip-plugin-acn"
  homepage: "https://github.com/acnlabs/paperclip-acn-plugin"
  repository: "https://github.com/acnlabs/paperclip-acn-plugin"
  acn_default_base_url: "https://api.acnlabs.dev"
  prerequisite_skill: "acn (https://api.acnlabs.dev/skill.md)"
allowed-tools: Bash(paperclipai:*) Bash(curl:api.acnlabs.dev) Bash(curl:acn.acnlabs.cn) Bash(openssl:rand) WebFetch
---

# Paperclip Plugin for ACN (Org Harness)

Bridges [Paperclip](https://github.com/paperclipai/paperclip) to ACN **Org Harness**:
human-created issues become **Org work items** (`POST /api/v1/orgs/{id}/work`),
not Task Pool tasks. Inbound `task.*` webhooks remain as a **legacy** mirror.

**Package:** `@acnlabs/paperclip-plugin-acn` ≥ 0.3.1  

**Org ↔ Task Pool (optional, ACN issue tab):** Import Task → Org work; Publish
network Task with `metadata.org_id`. Spec:
[org-task-bridge-v0](https://github.com/acnlabs/ACN/blob/main/docs/org-harness/org-task-bridge-v0.md).
Default Issue sync remains Org work only.

**Defaults to:** `https://api.acnlabs.dev` (use `https://acn.acnlabs.cn` for CN)  
**Prerequisite skill:** [`acn`](https://api.acnlabs.dev/skill.md)

---

## When to use this skill

- Install / configure `@acnlabs/paperclip-plugin-acn`
- Diagnose "issue not creating Org work" or harness webhook problems
- Switch `acnBaseUrl` (global vs CN) or bind an existing `org_…`

If the user has **no Paperclip** and wants raw ACN, load the ACN skill instead.

---

## Quickstart (Org work path)

End-to-end narrative (ACN docs):
[Org × Paperclip quickstart](https://github.com/acnlabs/ACN/blob/main/docs/org-harness/quickstart-org-paperclip.md).

```bash
paperclipai plugin install @acnlabs/paperclip-plugin-acn

# Bridge agent + subnet (ACN skill / CLI)
acn join --name "paperclip-bridge"
ACN_API_KEY=$(acn config get api_key)
SUBNET_ID=$(curl -s "$ACN_BASE/api/v1/subnets" \
  -H "Authorization: Bearer $ACN_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name":"paperclip-org","description":"Paperclip Org fence"}' \
  | jq -r '.slug // .subnet_id')

HARNESS_SECRET=$(openssl rand -hex 32)
paperclipai secrets set acn_api_key "$ACN_API_KEY"
paperclipai secrets set acn_harness_secret "$HARNESS_SECRET"

# Instance Settings → Plugins → ACN:
#   acnApiKeyRef        = acn_api_key
#   acnHarnessSecretRef = acn_harness_secret
#   acnSubnetId         = $SUBNET_ID   # plugin will POST /orgs once if acnOrgId empty
#   # OR set acnOrgId = org_… for an existing Org
#   paperclipBaseUrl    = https://<your-paperclip>
#   acnBaseUrl          = blank (global) or https://acn.acnlabs.cn
```

Expect setup logs:

```
acn-plugin: created ACN Org for company { org_id: "org_…", subnet_id: "…" }
# or: reusing / configured org
acn-plugin: registered harness { subnet_id: "…", org_id: "…", signed: true }
acn-plugin: setup complete { org_id: "…", subnet_id: "…" }
```

Copy the logged `org_id` into `acnOrgId` for stable restarts.

---

## Configuration

| Field | Required | Purpose |
|---|---|---|
| `acnApiKeyRef` | yes | Secret ref → `acn_…` key |
| `acnOrgId` | recommended | Existing `org_…`. Empty → create Org bound to `acnSubnetId` |
| `acnSubnetId` | yes if no Org | Fence subnet; also used when creating Org |
| `acnHarnessSecretRef` | strongly recommended | HMAC for inbound harness webhooks |
| `paperclipBaseUrl` | strongly recommended | Public Paperclip URL for webhook registration |
| `acnBaseUrl` | no | Default `https://api.acnlabs.dev` |
| `autoCreateIssues` | no (default `true`) | Inbound `org.work_created` → create Issue |
| `enableLegacyTaskMirror` | no (default `false`) | Opt-in: `task.created` + startup Task sync → Issue |
| `autoApproveOnDone` | no | Issue done → Org work PATCH (or legacy Task `/review`) |

**Subnet already bound:** if create Org returns 409 and the error message includes
`org_…`, the plugin reuses that Org. Otherwise set `acnOrgId` explicitly and restart.

**Multi-company:** only the first Paperclip company is bound to one ACN Org (v0.2).

---

## Behavior (v0.2)

### Paperclip → ACN (primary)

| Event | ACN effect |
|---|---|
| `issue.created` (human, not plugin echo) | `POST /orgs/{acnOrgId}/work` with issue title |
| `issue.updated` → `done` / `cancelled` | `PATCH /orgs/{id}/work/{work_id}` when in `issue-work-map` (`done` respects `autoApproveOnDone`) |

State: company-scoped `issue-work-map` (`work_id` → issue id).

### ACN → Paperclip (preferred)

| Event | Effect |
|---|---|
| `org.work_created` | Create Issue + `issue-work-map` (skipped if we just created the work outbound) |
| `org.work_updated` | Sync Issue status (`todo`/`done`/`cancelled`); `in_progress` → comment only |
| `org.loop_tick` | Comment on mapped open Issues (no L1 wakeup) |

### ACN → Paperclip (legacy, opt-in)

Requires `enableLegacyTaskMirror=true` to **create** Issues from Task Pool
(`task.created` + startup sync). Lifecycle events on **already-mapped** Issues
still apply when the flag is off.

| Event | Effect |
|---|---|
| `task.created` | Create Issue (flag on only) |
| `task.*` / `participation.*` (mapped) | Status / comments |

Issue done/cancelled → Task `/review` only when the issue was Task-mirrored (`issue-task-map`).

---

## Verify

```bash
# 1. Create a Paperclip issue as a human
# 2. List Org work on ACN
curl -s -H "Authorization: Bearer $ACN_API_KEY" \
  "$ACN_BASE/api/v1/orgs/$ORG_ID/work" | jq .
# Expect a work item with the issue title — NOT a row under /api/v1/tasks
```

---

## Common issues

| Symptom | Fix |
|---|---|
| Setup skipped: need org or subnet | Set `acnOrgId` or `acnSubnetId` |
| 409 subnet already bound, no org hint | Set `acnOrgId` to the Org that owns the subnet |
| Issue created, no Org work | Bridge agent must govern the Org (steward); check plugin logs |
| `signed: false` | Set `acnHarnessSecretRef` |
| Still creating Tasks | Upgrade to plugin ≥ 0.2.0 and restart |

---

## When to use the ACN skill

Agent join, subnet admission, A2A messaging, payments, key rotation — use the ACN skill.
This skill only covers Paperclip ↔ Org Harness wiring.
