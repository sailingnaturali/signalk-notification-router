# Changelog

All notable changes to `@sailingnaturali/signalk-notification-router` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.1.0 — 2026-08-09

- Added `hookBodyExtra`: an optional JSON object merged into the soft-lane
  webhook POST body alongside `message` (`message` always wins on a key
  collision). Some agent gateways need routing/delivery fields in the body,
  not just a message — without one, the hook endpoint can return 200, run the
  agent turn, and then silently fail to deliver the reply. The plugin stays
  gateway-agnostic: it merges whatever opaque JSON the operator supplies and
  never learns a specific gateway's field names. A malformed value is logged
  once at startup and otherwise ignored rather than taking down the lane.

## 1.0.0 — 2026-08-09

Renamed from `@sailingnaturali/signalk-ntfy-relay`. Version starts at 1.0.0 because the
repo kept its old tags (v0.1.0–v0.2.0 belong to the ntfy relay) — 1.x is the first
unambiguous line for this package. The ntfy sender is gone;
what remains is the part worth keeping — the `notifications.*` subscription,
the edge-trigger, and the delivery-path health tracking.

- Three outputs: MQTT (retained envelopes), a Telegram siren for
  `alarm`/`emergency`, and an agent webhook for `alert`/`warn`.
- The notification's own `method` decides whether it pushes at all. No `sound`,
  no push, at any severity — and no path allowlist anywhere.
- The soft lane batches inside a coalesce window; the hard lane never does.
- Delivery-path health is tracked per lane and raises a `visual`-only
  notification so it cannot loop through the failing lane.
- Replaces the `notifications-mqtt` Python sidecar, which polled REST every 5 s
  and hand-rolled the flattening and edge-triggering this gets from the platform.

— history below is from the old @sailingnaturali/signalk-ntfy-relay package name —

## [0.2.0]

### Added

- **Delivery-path health check.** A proactive `/v1/account` heartbeat
  (`healthCheckIntervalHours`, default 24; token-only) plus reactive
  consecutive-send-failure counting raise `notifications.ntfyRelay.deliveryFailed`
  after `failureThreshold` (default 3) failures — so a silently broken push path
  (expired token, ACL, outage) surfaces on the dashboard/voice instead of going
  unnoticed until the next real alarm. The health notification is never forwarded
  to ntfy (no loop) and clears on the next success.
- `scripts/ntfy-doctor.js` — a CLI to diagnose the ntfy path (`check` / `test` /
  `poll`) without waiting for a real alarm. Dev tool, not shipped in the package.

## [0.1.2]

### Security

- Sanitise the outbound `Title` header before sending to ntfy. The title is
  built from the notification path and state; a CR/LF in a path could smuggle
  extra headers into the request or trip Node's `ERR_INVALID_CHAR` and silently
  drop the alarm push. Control-character runs now collapse to a single space and
  the title is length-capped. Defence-in-depth on in-process but untrusted data.

## [0.1.1]

### Added

- Initial published release. Watches `notifications.*`, edge-triggers on state
  change, and POSTs active alarms at or above a configurable severity to an ntfy
  topic. Zero runtime dependencies. Optional cleared-alarm messages and appended
  vessel position.
