# Changelog

All notable changes to `@acnlabs/paperclip-plugin-acn` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Docs

- Rewrite README for Paperclip users: value prop, shortest install,
  success criteria, troubleshooting; ACN design docs as deep links.
- Link ACN Org × Paperclip quickstart from README / SKILL.

## [0.3.1] - 2026-07-23

### Added

- **Org ↔ Task Pool thin bridge (issue ACN tab):** Import a network Task as
  Org work (`acn-import-task` → `POST /orgs/{id}/work/import-task`) and bind
  it to the current Issue; Publish a network Task attributed to the Org
  (`acn-publish-task`, `metadata.org_id` / `org_publish`). Explicit only —
  does not change default Issue → Org work sync. Spec:
  [org-task-bridge-v0](https://github.com/acnlabs/ACN/blob/main/docs/org-harness/org-task-bridge-v0.md).

## [0.3.0] - 2026-07-23

### Changed

- **Legacy Task Pool mirror is opt-in.** New config `enableLegacyTaskMirror`
  (default `false`) gates `task.created` → Issue create and startup
  `syncTasks`. Prefer Org `org.*` inbound. Already-mapped Task Issues still
  receive `task.*` lifecycle updates and `/review` when the flag is off.
- **`autoCreateIssues`** now only controls inbound `org.work_created` Issue
  create (default remains `true`). It no longer gates Task Pool mirroring.

### Fixed

- **`org.loop_tick` comments:** comment on every mapped open work in the tick
  payload (Redis set order made "first only" nondeterministic). Log cooldown
  skips and comment targets.
- Manifest `PLUGIN_VERSION` was stuck at `0.2.0`; now tracks the package
  version (`0.3.0`).

## [0.2.1] - 2026-07-23

### Changed

- Depend on `acn-client` **^0.15.0** Org Work Port APIs; `org-api.ts` is now a
  thin façade over `ACNClient` (`getOrg` / `createOrg` / `createWork` /
  `updateWork`). Conflict recovery uses `ACNError.boundOrgIdHint`.

## [0.2.0] - 2026-07-22

### Changed

- **P2c C0/C1 — Issue create → Org work.** Human-created Paperclip issues now
  call `POST /api/v1/orgs/{org_id}/work` instead of Task Pool `createTask`.
- **P2c C2 — Inbound `org.work_*` / `org.loop_tick`.** Harness webhooks for
  Org work create/update mirror into Issues via `issue-work-map`; loop ticks
  leave one throttled comment on the first mapped open work. In-flight binding
  covers ACN's synchronous harness POST during `createWork` (no twin Issue);
  late retries use a post-persist echo set. ACN issue tab renders Org work
  ids without crashing on null Task fields. Note: for org.* events ACN's
  `task_id` field carries `org_id` — the plugin keys off `event` + `data.work_id`.
- New config `acnOrgId`. When empty, setup creates an Org bound to
  `acnSubnetId` and stores the id in company-scoped plugin state.
- New state map `issue-work-map` (`work_id` → issue id). Legacy
  `issue-task-map` remains for inbound `task.*` mirroring and review.
- On `subnet_already_bound` (409): reuse Org id from error message when
  present; otherwise fail with an explicit “set `acnOrgId`” instruction.
- Warn when `acnSubnetId` disagrees with the Org fence (prefer Org fence).
- Warn when multiple Paperclip companies exist (only the first is bound).
- `SKILL.md` rewritten for the Org work path (no longer teaches `createTask`).

- **P2c C3 — Issue status → Org work PATCH.** Moving an Org-mapped issue to
  `done` / `cancelled` calls `PATCH /orgs/{id}/work/{work_id}`. `done` still
  respects `autoApproveOnDone`; `cancelled` always syncs. Legacy Task `/review`
  remains only for issues linked via `issue-task-map`.

### Deprecated

- Outbound Issue → Task Pool create (removed).
- Inbound `task.*` mirror remains for transition; Issue → Task `/review` only
  for legacy Task-mirrored issues.

## [0.1.1] - 2026-05-16

### Fixed

- **Default `acnBaseUrl` now points at the live ACN production endpoint
  (`https://api.acnlabs.dev`)**. The `v0.1.0` release shipped with a
  placeholder vanity domain (`https://acn.agentplanet.io`) that was never
  actually registered — installing the plugin without overriding the URL would
  fail at the first ACN call with `getaddrinfo ENOTFOUND`. With this release,
  new users can install the plugin and connect to ACN Labs' hosted production
  with zero additional infrastructure; self-hosters can still override
  `acnBaseUrl` to point at their own deployment.

### Changed

- `instanceConfigSchema.acnBaseUrl.description` now spells out the hosted /
  self-host trade-off so the choice is visible in Paperclip's Instance
  Settings UI without having to read the README.
- README `Prerequisites` and `Configuration` sections updated to reflect that
  an ACN deployment is no longer something the user has to bring — the
  default is a working public endpoint.

## [0.1.0] - 2026-05-15

### Added

- Initial public release on npm.
- Bidirectional sync between Paperclip issues and ACN tasks:
  - ACN → Paperclip: `task.created` / `accepted` / `submitted` / `completed`
    / `rejected` / `cancelled` / `participation.rejected` webhooks mirror
    state into issue lifecycle + comments.
  - Paperclip → ACN: human-created issues spawn ACN tasks in the configured
    subnet; moving an issue to `done` (with `autoApproveOnDone`) or
    `cancelled` posts the corresponding `/tasks/:id/review` decision.
- HMAC-SHA256 signed harness webhooks (`X-ACN-Signature: sha256=<hex>`),
  with a compatibility layer for Paperclip's `secrets.read-ref` capability.
- Issue-detail "ACN" tab showing task ID, status, reward, participants, and
  approve / reject actions for pending submissions.
- GitHub Actions: `ci.yml` (typecheck + build + tests + pack dry-run on
  push/PR to main) and `release.yml` (npm publish + GitHub Release on
  `v*` tags).
