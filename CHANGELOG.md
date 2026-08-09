# Changelog

All notable changes to `@sailingnaturali/signalk-notification-router` are documented here.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## 1.2.0 — 2026-08-09

Delivery-health fixes found by a whole-branch review. **Anyone who ran 1.0.0–1.1.0 is
affected by the first two.**

- **Fixed: the delivery-health alarm itself did not reach MQTT.** `onDelta` skipped its own
  `notifications.notificationRouter.deliveryFailed.<lane>` notifications before the MQTT
  publish, not just before routing — so MQTT, the only path from the notifications tree to
  the voice agent and the dashboard, never carried the "a lane is dead" alarm. It reached
  nobody except someone already logged into the SignalK admin UI. Self-notifications now
  publish to MQTT like any other forwardable row; only the push-lane routing is still
  skipped (safe: the notification carries `method: ['visual']`, so `classify` can never
  assign it a lane, and an MQTT failure cannot re-raise past the `raised` guard).
- **Fixed: a raised delivery-health alarm could latch across a plugin restart.**
  `plugin.start` cleared `raised` as well as `failures`. Sequence: a lane fails past
  threshold and raises `deliveryFailed` in the tree → the operator saves config in the
  admin UI (SignalK calls `stop` then `start`) → `raised` is emptied but the tree still
  shows `alert` → the lane recovers → `recordResult` never sees the lane as raised, so it
  never clears it → the tree shows a failed lane forever, until the whole server restarts.
  `raised` is no longer cleared on start; `failures` still is (a stale failure streak
  correctly shouldn't count toward the new threshold).
- **Fixed: MQTT health tracking went dark during a broker outage.** mqtt.js only invokes
  the `publish` callback on PUBACK; while the broker is unreachable the callback never
  fires, so `recordResult('mqtt', …)` ran on neither success nor failure and
  `deliveryFailed.mqtt` could never raise — during exactly the outage it exists to report.
  `publishMqtt` now records a failure immediately when `mqttClient.connected === false`,
  and still publishes (qos-1 messages queue and flush on reconnect).
- Removed a real Telegram chat id that had been committed to `index.test.js`.
- `deliver`'s terminal `.catch` (and the MQTT publish callback's `recordResult` call) are
  now guarded against `app.error`/`recordResult` themselves throwing, so a delivery
  failure can no longer become an unhandled rejection on the alarm path.
- The cleared-notification MQTT envelope is now built through `buildEnvelope` instead of a
  second hand-rolled copy of the same shape.
- `hookBodyExtra: '{}'` (a deliberate empty object) no longer trips the "is not a JSON
  object" startup warning.
- `plugin.start` is now self-guarding: it calls `plugin.stop()` first, so a `start()`
  without a preceding `stop()` can no longer leave a stale subscription registered
  alongside the new one.
- `postHook` now sanitizes a rejected fetch the same way `sendTelegram` does (timeout vs.
  network error, no raw transport error text), rather than letting undici's error message
  through.

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
