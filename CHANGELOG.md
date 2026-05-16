# Changelog

All notable changes to `@acnlabs/paperclip-plugin-acn` are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
