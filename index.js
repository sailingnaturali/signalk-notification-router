/*
 * signalk-notification-router — route SignalK notifications to MQTT, Telegram
 * and an agent webhook.
 *
 * Watches notifications.* in-process and edge-triggers on state change. Three
 * outputs with deliberately independent failure modes: every forwardable
 * notification goes to MQTT; alarm/emergency sirens straight to the Telegram
 * Bot API with no gateway and no model in the path; alert/warn wake an agent
 * turn via a webhook. The notification's own `method` decides whether it
 * pushes at all — no `sound`, no push, at any severity.
 *
 * Ported from infrastructure/pi5-signalk/notifications-mqtt/forward.py, which
 * polled REST on a 5 s timer and hand-rolled all of the above.
 *
 * The factory takes an optional second arg `deps` so tests can inject fake
 * senders; SignalK calls it with just (app).
 */
const mqtt = require('mqtt');

const SEVERITY = { nominal: 0, normal: 1, alert: 2, warn: 3, alarm: 4, emergency: 5 };
const INACTIVE = new Set(['nominal', 'normal']);

// Lane split. `state` picks the lane; `method` decides whether it pushes at all.
const HARD = new Set(['alarm', 'emergency']);   // siren + agent follow-up
const SOFT = new Set(['alert', 'warn']);        // agent turn only

function rank(state) {
  return state in SEVERITY ? SEVERITY[state] : -1;
}
function isActive(state) {
  return state != null && !INACTIVE.has(state);
}
function shouldForward(state, minState) {
  return isActive(state) && rank(state) >= rank(minState);
}

// Which push lane this notification takes, or null for no push.
//
// SignalK's `method` array is the publisher declaring how it wants to be
// surfaced: ["visual"] means display, do not sound. A publisher that does not
// ask for sound never pages the Captain, whatever the severity — that is what
// keeps blanket geofence warnings (signalk-restricted-areas) off the phone
// without a path allowlist. Anything not an array is treated as "did not ask".
function classify(state, method) {
  if (state == null || INACTIVE.has(state) || !(state in SEVERITY)) return null;
  if (!Array.isArray(method) || !method.includes('sound')) return null;
  if (HARD.has(state)) return 'hard';
  if (SOFT.has(state)) return 'soft';
  return null;
}

// The MQTT envelope. FROZEN CONTRACT — Poseidon and Home Assistant parse this
// off naturali/alerts/<path>. Key order matches the Python original, and every
// optional key is `?? null` rather than left undefined, because JSON.stringify
// drops undefined keys and the consumers expect the key to be present.
function buildEnvelope(n, position) {
  const env = {
    path: n.path,
    state: n.state,
    message: n.message ?? null,
    timestamp: n.timestamp ?? null,
  };
  if (
    position &&
    typeof position.latitude === 'number' &&
    typeof position.longitude === 'number'
  ) {
    env.position = { latitude: position.latitude, longitude: position.longitude };
  }
  return env;
}

// Human-readable form of a SignalK notification path.
//
// Instance ids — uuids, timestamped DSC keys — mean nothing to someone reading
// a phone at 3am, and on a narrow screen they push the actual message out of
// view. Drop any segment long enough to be an id and keep the meaningful
// prefix. Falls back to the original if every segment looks like an id.
function shortPath(path) {
  const text = String(path);
  const kept = text.split('.').filter((s) => s.length <= 20);
  return kept.join('.') || text;
}

// Hard-lane Telegram text. No model touches this.
//
// It may be the only message that ever arrives — if the gateway or the model
// API is down, the follow-up never comes — so it has to stand alone.
function renderSiren(env) {
  const lines = [`⚠ ${String(env.state).toUpperCase()} — ${shortPath(env.path)}`];
  if (env.message) lines.push(String(env.message));
  const pos = env.position;
  if (pos) lines.push(`${pos.latitude.toFixed(5)}, ${pos.longitude.toFixed(5)}`);
  return lines.join('\n');
}

// Hard-lane agent prompt: the Captain has ALREADY been paged.
function renderFollowupPrompt(env) {
  return (
    `A ${env.state} notification on ${env.path} has already been sent to the ` +
    `Captain directly: "${env.message || env.path}". ` +
    'Do not repeat it. Read the vessel and send ONE short follow-up with the ' +
    'context that makes it actionable — depth, wind, position, trend, ' +
    'nearby hazards, whatever is relevant to this alarm. Numbers with units. ' +
    'If nothing useful can be added, say so in one line.'
  );
}

// Soft-lane agent prompt: a batch of changed notifications, unannounced.
function renderAgentPrompt(rows) {
  const listing = rows
    .map((r) => `- ${r.path} = ${r.state}` + (r.message ? `: ${r.message}` : ''))
    .join('\n');
  return (
    'SignalK notifications changed. The Captain has NOT been told yet:\n' +
    `${listing}\n\n` +
    'Read the vessel to see what is going on — notifications at ' +
    'http://localhost:3000/signalk/v1/api/vessels/self/notifications, plus ' +
    'battery SOC, depth below keel, wind and tank levels if relevant. Send ' +
    'the Captain ONE concise heads-up (1-3 sentences), most important first, ' +
    'numbers with units.'
  );
}

// Hard lane. Straight to the Telegram Bot API — no gateway, no model, no MQTT.
//
// Checks res.ok by hand rather than surfacing res.url or the response body:
// the bot token is IN the request URL, and a thrown Error carrying it would be
// written verbatim into the SignalK log. Status code only.
async function sendTelegram(text, opts) {
  const doFetch = opts.fetch || fetch;
  let res;
  try {
    res = await doFetch(
      `https://api.telegram.org/bot${opts.telegramBotToken}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: opts.telegramChatId, text }),
        signal: AbortSignal.timeout(10000),
      }
    );
  } catch (e) {
    // The bot token is in the request URL, so nothing derived from the
    // transport error is safe to surface — a rejected fetch must not carry
    // it into app.error() and from there into the on-disk log. Node does not
    // currently put the URL in e.message, but that is undici's formatting
    // choice, not a guarantee we should depend on.
    throw new Error(
      e.name === 'TimeoutError'
        ? 'telegram sendMessage failed: timeout'
        : 'telegram sendMessage failed: network error'
    );
  }
  if (!res.ok) throw new Error(`telegram sendMessage failed: HTTP ${res.status}`);
}

// Soft lane. Wakes an agent turn via the OpenClaw gateway hooks endpoint.
// Returns on admission (up to ~15 s), not on completion.
async function postHook(message, opts) {
  const doFetch = opts.fetch || fetch;
  const res = await doFetch(opts.hookUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.hookToken}`,
    },
    body: JSON.stringify({ message }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`hook POST failed: HTTP ${res.status}`);
}

// mqtt.js reconnects on its own and queues QoS-1 publishes while offline, so an
// unreachable broker never blocks startup or the routing path — matching the
// Python original's connect_async + best-effort publish.
function connectMqtt(opts) {
  return mqtt.connect(opts.mqttUrl, {
    username: opts.mqttUser || undefined,
    password: opts.mqttPassword || undefined,
    reconnectPeriod: 5000,
  });
}

module.exports = function (app, deps) {
  const senders = {
    sendTelegram: (deps && deps.sendTelegram) || sendTelegram,
    postHook: (deps && deps.postHook) || postHook,
    connectMqtt: (deps && deps.connectMqtt) || connectMqtt,
  };

  const plugin = {
    id: 'signalk-notification-router',
    name: 'Notification Router',
    description: 'Route Signal K notifications to MQTT, Telegram and an agent webhook.',
  };

  // Our own delivery-path alarms live under this prefix. They surface on the
  // dashboard and voice — channels independent of whichever push lane is down —
  // and are never routed back out (see onDelta), so they cannot loop through
  // the failing path.
  const SELF_PREFIX = 'notificationRouter.';

  plugin.schema = {
    type: 'object',
    required: ['topic'],
    properties: {
      server: {
        type: 'string',
        title: 'ntfy server base URL',
        default: 'https://ntfy.sh',
      },
      topic: {
        type: 'string',
        title: 'ntfy topic to publish alarms to',
      },
      token: {
        type: 'string',
        title: 'Access token (optional, for self-hosted/ACL servers)',
        default: '',
      },
      minState: {
        type: 'string',
        title: 'Minimum severity to forward',
        enum: ['alert', 'warn', 'alarm', 'emergency'],
        default: 'warn',
      },
      notifyOnClear: {
        type: 'boolean',
        title: 'Send a message when an alarm clears',
        default: true,
      },
      includePosition: {
        type: 'boolean',
        title: 'Append vessel position to the message',
        default: true,
      },
      healthCheckIntervalHours: {
        type: 'number',
        title: 'Delivery-path health check interval (hours)',
        description:
          'Periodically verify the ntfy token/server via /v1/account so a broken push path (expired token, ACL, outage) is caught before the next real alarm. 0 disables. Only runs when an access token is set.',
        default: 24,
      },
      failureThreshold: {
        type: 'number',
        title: 'Consecutive failures before raising a delivery-path alarm',
        description:
          'How many consecutive send/health-check failures before raising notifications.ntfyRelay.deliveryFailed (rides out transient network blips).',
        default: 3,
      },
    },
  };

  let unsubscribes = [];
  let lastState = new Map();
  let currentOptions = {};
  const failures = new Map();   // lane -> consecutive failure count
  const raised = new Set();     // lanes currently carrying a deliveryFailed alarm
  let failureThreshold = 3;

  // Per-lane, not global: MQTT going down must not raise "Telegram is failing".
  // The alarm is method: ['visual'] so classify() can never push it, and
  // onDelta skips SELF_PREFIX so it can never loop through the failing lane.
  // It still surfaces on the dashboard and voice.
  function setDeliveryFailed(lane, active) {
    app.handleMessage(plugin.id, {
      updates: [{ values: [{
        path: `notifications.${SELF_PREFIX}deliveryFailed.${lane}`,
        value: active
          ? {
              state: 'alert',
              method: ['visual'],
              message: `${lane} delivery path failing — notifications are not reaching it`,
              timestamp: new Date().toISOString(),
            }
          : { state: 'normal', method: [], message: '' },
      }] }],
    });
  }

  function recordResult(lane, ok) {
    if (ok) {
      failures.set(lane, 0);
      if (raised.has(lane)) { raised.delete(lane); setDeliveryFailed(lane, false); }
      return;
    }
    const n = (failures.get(lane) || 0) + 1;
    failures.set(lane, n);
    if (n >= failureThreshold && !raised.has(lane)) {
      raised.add(lane);
      setDeliveryFailed(lane, true);
    }
  }

  // Fire-and-forget with the outcome fed to the health counter. Never awaited:
  // a wedged gateway must not serialize a later row's siren behind an earlier
  // row's 20 s hook timeout, and nothing downstream needs the result.
  function deliver(lane, fn) {
    Promise.resolve()
      .then(fn)
      .then(() => recordResult(lane, true))
      .catch((e) => {
        app.error(`delivery error on the ${lane} lane: ${e.message}`);
        recordResult(lane, false);
      });
  }

  function position() {
    const node = app.getSelfPath('navigation.position');
    if (node == null) return undefined;
    const v = typeof node === 'object' && 'value' in node ? node.value : node;
    return v && typeof v.latitude === 'number' ? v : undefined;
  }

  // Task 5 replaces this with the real routing. Kept as a stub so the
  // subscribe wiring below has something to call while the ntfy sender is
  // gone and the router is not yet built.
  function onDelta() {}

  plugin.start = function (options) {
    options = options || {};
    lastState = new Map();
    currentOptions = options;
    failureThreshold = options.failureThreshold > 0 ? options.failureThreshold : 3;
    failures.clear();
    raised.clear();
    app.subscriptionmanager.subscribe(
      {
        context: 'vessels.self',
        subscribe: [{ path: 'notifications.*', policy: 'instant' }],
      },
      unsubscribes,
      (err) => app.error(err),
      (delta) => {
        try {
          onDelta(delta, options);
        } catch (e) {
          app.error(`signalk-ntfy-relay: ${e.message}`);
        }
      }
    );
  };

  plugin.stop = function () {
    unsubscribes.forEach((f) => f());
    unsubscribes = [];
    lastState = new Map();
  };

  return plugin;
};

// Pure helpers, hung off the factory for unit tests.
module.exports._internal = { rank, isActive, shouldForward, classify, buildEnvelope, shortPath, renderSiren, renderFollowupPrompt, renderAgentPrompt, sendTelegram, postHook, connectMqtt };
