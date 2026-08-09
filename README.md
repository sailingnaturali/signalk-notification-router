# @sailingnaturali/signalk-notification-router

Route [Signal K](https://signalk.org) notifications to MQTT, Telegram and an
agent webhook — three outputs with deliberately independent failure modes.

Watches `notifications.*` in-process via the subscription manager and
**edge-triggers**: it acts once when a notification changes state, not
repeatedly while it persists.

## Looking for ntfy?

This plugin does not send to [ntfy](https://ntfy.sh) — it was renamed from
`@sailingnaturali/signalk-ntfy-relay` and the ntfy sender was removed.
[signalk-ntfy](https://github.com/Enand-lab/signalk-ntfy) (Apache-2.0) is actively
developed and does that job, against ntfy.sh or a self-hosted server.

## The routing rule

**`method` decides whether a notification pushes at all; `state` decides which
lane.**

| Output | Trigger | Depends on |
|---|---|---|
| MQTT `<prefix>/<path>` | every notification at or above `minState` | the broker |
| Telegram siren | `alarm`/`emergency` **with `sound` in `method`** | the internet only |
| Agent webhook | `alert`/`warn` with `sound`, plus a context follow-up after every siren | the gateway and the model behind it |

Some gateways need more than `{"message": "..."}` to actually deliver the
reply — the message alone can complete an agent turn and then drop it on the
floor. Set `hookBodyExtra` to a JSON object and it's merged into the POST body
alongside `message` (which always wins on a key collision). Against the
OpenClaw gateway, for example, the delivery target is a body field, not
implied by the URL: `{"deliver":true,"channel":"telegram","to":"<chatId>"}`.
This plugin doesn't know or care what your gateway calls its fields — it just
merges what you give it.

A Signal K notification's `method` array is the publisher saying how it wants to
be surfaced. `["visual"]` means *display this, do not sound it*. A publisher
that does not ask for `sound` reaches MQTT and stops — at any severity. That is
what keeps a blanket geofence warning off your phone **without a path
allowlist**, which this plugin deliberately does not have. If something routes
wrong, fix it at the publisher.

## Two lanes, failing independently

The hard lane needs Signal K, this plugin, and the internet. The soft lane needs
all of that *plus* a working gateway and a live model API. The alarm that
matters most depends on the fewest things — so the siren goes straight to the
Telegram Bot API and is never routed through the webhook for tidiness.

The hard lane never batches: deduplication is a comfort feature, a missed alarm
is not. The soft lane batches inside `coalesceSeconds` so a burst of related
transitions becomes one agent turn instead of six.

## Delivery-path health

A blank token and an expired one both fail silently, which is how a push path
dies unnoticed. After `failureThreshold` consecutive failures on a lane, the
plugin raises `notifications.notificationRouter.deliveryFailed.<lane>` — a
`visual`-only notification, so it surfaces on your dashboard rather than
attempting to page through the very lane that is down. Any success clears it.

## Config

All fields optional; a lane with no credentials idles and logs why at startup.

| Field | Default | Notes |
|---|---|---|
| `minState` | `alert` | Minimum severity to forward anywhere |
| `mqttUrl` | `mqtt://localhost:1883` | Blank disables the MQTT output |
| `mqttUser` / `mqttPassword` | — | Blank user means anonymous |
| `topicPrefix` | `naturali/alerts` | |
| `telegramBotToken` / `telegramChatId` | — | Hard lane |
| `hookUrl` / `hookToken` | — | Soft lane; POSTs `{"message": "..."}` (plus anything set in `hookBodyExtra`) with a bearer token |
| `hookBodyExtra` | — | Optional JSON object merged into that POST body, `message` always wins |
| `coalesceSeconds` | `10` | Soft-lane batching window |
| `failureThreshold` | `3` | Per lane |

## MQTT envelope

Published retained at QoS 1:

```json
{
  "path": "navigation.anchor",
  "state": "alarm",
  "message": "Anchor dragging",
  "timestamp": "2026-08-06T22:14:03Z",
  "position": { "latitude": 48.76021, "longitude": -123.05213 }
}
```

`position` is present only when a numeric fix is available. When a forwarded
notification clears, a `{"state": "normal", "message": "cleared"}` envelope is
published to the same topic — cleared notifications never page and never wake
the agent.

## Testing a lane

`scripts/inject-test-notification.js` injects a notification at any state and
`method` over the delta WebSocket, which is the only thing that works — a `PUT`
to the notifications REST path returns 404.

```bash
SIGNALK_TOKEN=... node scripts/inject-test-notification.js \
  --host localhost --path test.softLane --state warn --method visual,sound \
  --message "TEST - ignore"
```

Re-run with `--state normal` to clear.

## License

MIT
