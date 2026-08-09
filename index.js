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

// Parse the operator's extra-body JSON. Never throws: a malformed value must
// not take down the soft lane, and plugin.start already logged it loudly at
// configuration time. Anything that is not a JSON object is ignored.
function parseHookExtra(raw) {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// Did `raw` parse as a JSON object (an empty `{}` counts)? Distinct from
// "parseHookExtra returned no keys", which is also true for a deliberate
// `{}` — this is used only for the startup warning, so a valid empty object
// does not trip a spurious "is not a JSON object" error.
function isJsonObject(raw) {
  try {
    const v = JSON.parse(raw);
    return v != null && typeof v === 'object' && !Array.isArray(v);
  } catch {
    return false;
  }
}

// Soft lane. Wakes an agent turn via the OpenClaw gateway hooks endpoint.
// Returns on admission (up to ~15 s), not on completion.
async function postHook(message, opts) {
  const doFetch = opts.fetch || fetch;
  // Whatever the operator's webhook consumer needs beyond the message —
  // routing, delivery targets, model overrides. Kept as opaque JSON so this
  // plugin stays agnostic about which agent gateway is on the other end.
  // `message` is spread last so extra JSON can never clobber it.
  let res;
  try {
    res = await doFetch(opts.hookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.hookToken}`,
      },
      body: JSON.stringify({ ...parseHookExtra(opts.hookBodyExtra), message }),
      signal: AbortSignal.timeout(20000),
    });
  } catch (e) {
    // No secret is in the hook URL today (the bearer token is a header), but
    // it carries a deliberately non-guessable gateway path — same reasoning
    // as sendTelegram's catch: a rejected fetch must not carry undici's
    // formatting of the URL into app.error() and from there into the log.
    throw new Error(
      e.name === 'TimeoutError'
        ? 'hook POST failed: timeout'
        : 'hook POST failed: network error'
    );
  }
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

  // Our own delivery-path alarms live under this prefix. They still publish
  // to MQTT — channels independent of whichever push lane is down, e.g. the
  // dashboard and voice, read off it — but are never routed back out through
  // the Telegram/webhook lanes (see onDelta), so they cannot loop through the
  // failing path.
  const SELF_PREFIX = 'notificationRouter.';

  plugin.schema = {
    type: 'object',
    properties: {
      minState: {
        type: 'string',
        title: 'Minimum severity to forward',
        description: 'Notifications below this never reach any output.',
        enum: ['alert', 'warn', 'alarm', 'emergency'],
        default: 'alert',
      },
      mqttUrl: {
        type: 'string',
        title: 'MQTT broker URL',
        description: 'Every forwardable notification is published here as a retained envelope. Leave blank to disable the MQTT output.',
        default: 'mqtt://localhost:1883',
      },
      mqttUser: { type: 'string', title: 'MQTT username (blank for anonymous)', default: '' },
      mqttPassword: { type: 'string', title: 'MQTT password', format: 'password', default: '' },
      topicPrefix: { type: 'string', title: 'MQTT topic prefix', default: 'naturali/alerts' },
      telegramBotToken: {
        type: 'string',
        title: 'Telegram bot token (hard lane)',
        description: 'alarm/emergency notifications carrying `sound` go straight to the Telegram Bot API — no gateway, no model, no MQTT.',
        format: 'password',
        default: '',
      },
      telegramChatId: { type: 'string', title: 'Telegram chat id', default: '' },
      hookUrl: {
        type: 'string',
        title: 'Agent webhook URL (soft lane)',
        description: 'alert/warn notifications carrying `sound` are batched and POSTed here as {"message": "..."} (plus anything set in hookBodyExtra) to wake an agent turn. Also receives a context follow-up after every siren.',
        default: '',
      },
      hookToken: { type: 'string', title: 'Agent webhook bearer token', format: 'password', default: '' },
      hookBodyExtra: {
        type: 'string',
        title: 'Extra JSON merged into the webhook body',
        description: 'Optional JSON object merged into the POST body alongside `message`, for whatever your agent gateway needs to route and deliver the reply. For OpenClaw: {"deliver":true,"channel":"telegram","to":"<chatId>"} — without a delivery target, its hook runs can complete the agent turn and then fail to deliver. `message` always wins over anything set here.',
        default: '',
      },
      coalesceSeconds: {
        type: 'number',
        title: 'Soft-lane batching window (seconds)',
        description: 'A burst of soft transitions becomes one agent turn. Measured from the first row in the batch. The hard lane never batches.',
        default: 10,
      },
      failureThreshold: {
        type: 'number',
        title: 'Consecutive failures before raising a delivery-path alarm',
        description: 'Per lane. Raises notifications.notificationRouter.deliveryFailed.<lane> (visual only, so it cannot loop through the failing lane).',
        default: 3,
      },
    },
  };

  let unsubscribes = [];
  let lastState = new Map();
  let currentOptions = {};
  let pendingSoft = [];     // soft-lane rows waiting for the coalesce window
  let flushTimer = null;
  let mqttClient = null;
  const failures = new Map();   // lane -> consecutive failure count
  const raised = new Set();     // lanes currently carrying a deliveryFailed alarm
  let failureThreshold = 3;

  // Per-lane, not global: MQTT going down must not raise "Telegram is failing".
  // The alarm is method: ['visual'] so classify() can never push it, and
  // onDelta only skips SELF_PREFIX for routing, not the MQTT publish, so it
  // still surfaces on the dashboard and voice — and can never loop through
  // the failing push lane.
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
      })
      // app.error or recordResult (which fans out via app.handleMessage to
      // every other plugin's subscribers) can itself throw — a lane failure
      // must never become an unhandled rejection on the alarm path.
      .catch(() => {});
  }

  function position() {
    const node = app.getSelfPath('navigation.position');
    if (node == null) return undefined;
    const v = typeof node === 'object' && 'value' in node ? node.value : node;
    return v && typeof v.latitude === 'number' ? v : undefined;
  }

  // The window runs from the OLDEST pending row: arm once when the buffer goes
  // non-empty, never re-arm while one is in flight. A steady trickle of
  // transitions would otherwise reset the timer forever and never flush.
  // (This is what replaced the Python coalesce() — the timer IS the rule.)
  function armFlush() {
    if (flushTimer) return;
    const ms = (currentOptions.coalesceSeconds ?? 10) * 1000;
    flushTimer = setTimeout(flushSoft, ms);
    if (flushTimer.unref) flushTimer.unref();
  }

  function flushSoft() {
    flushTimer = null;
    if (!pendingSoft.length) return;   // emptied by the I6 filter below
    const batch = pendingSoft;
    pendingSoft = [];
    let prompt;
    try {
      prompt = renderAgentPrompt(batch);
    } catch (e) {
      app.error(`routing error rendering the soft batch: ${e.message}`);
      return;
    }
    deliver('hook', () => senders.postHook(prompt, currentOptions));
  }

  // Route newly-active notification rows.
  //
  // Hard lane fires per-row immediately and never coalesces — deduplication is
  // a comfort feature, a missed alarm is not. Soft lane batches.
  //
  // Deliveries are fire-and-forget (see deliver), so a wedged gateway cannot
  // serialize a later row's siren behind an earlier row's hook timeout.
  function route(rows) {
    const hardEnvs = [];
    for (const row of rows) {
      try {
        const lane = classify(row.state, row.method);
        if (lane === 'hard') hardEnvs.push(buildEnvelope(row, position()));
        else if (lane === 'soft') pendingSoft.push(row);
      } catch (e) {
        app.error(`routing error for ${row.path}: ${e.message}`);
      }
    }

    for (const env of hardEnvs) {
      let text;
      try {
        text = renderSiren(env);
      } catch (e) {
        app.error(`routing error rendering the siren for ${env.path}: ${e.message}`);
        continue;
      }
      deliver('telegram', () => senders.sendTelegram(text, currentOptions));
    }
    for (const env of hardEnvs) {
      let prompt;
      try {
        prompt = renderFollowupPrompt(env);
      } catch (e) {
        app.error(`routing error rendering the follow-up for ${env.path}: ${e.message}`);
        continue;
      }
      deliver('hook', () => senders.postHook(prompt, currentOptions));
    }

    // I6: a path that just fired hard must not also flush a stale soft prompt —
    // the siren already told the Captain, at the newer and correct severity.
    // Filter the whole buffer, not just the new rows: a path can appear twice
    // in one delta batch (a warn and an alarm), so the warn may be sitting in
    // either place. flushSoft() no-ops on an empty buffer, so a timer already
    // armed needs no cancelling.
    if (hardEnvs.length) {
      const hardPaths = new Set(hardEnvs.map((e) => e.path));
      pendingSoft = pendingSoft.filter((r) => !hardPaths.has(r.path));
    }
    if (pendingSoft.length) armFlush();
  }

  function publishMqtt(topic, envelope) {
    if (!mqttClient) return;
    // mqtt.js only calls the publish callback on PUBACK, so an unreachable
    // broker would otherwise record neither success nor failure — the health
    // counter would sit silent through the exact outage it exists to report.
    // Still publish: qos-1 messages queue and flush on reconnect.
    if (mqttClient.connected === false) recordResult('mqtt', false);
    mqttClient.publish(topic, JSON.stringify(envelope), { qos: 1, retain: true }, (err) => {
      // mqtt.js invokes this directly, not through a promise chain, so an
      // uncaught throw here (recordResult fans out via app.handleMessage to
      // every other plugin's subscribers) would crash the process rather
      // than just failing to record one delivery outcome. Best-effort log;
      // a throw from app.error itself must not escape here either.
      try {
        recordResult('mqtt', !err);
      } catch (e) {
        try { app.error(`mqtt publish callback error: ${e.message}`); } catch {}
      }
    });
  }

  function onDelta(delta) {
    const minState = currentOptions.minState || 'alert';
    const prefix = currentOptions.topicPrefix || 'naturali/alerts';
    const newlyActive = [];

    for (const u of delta.updates || []) {
      for (const v of u.values || []) {
        if (!v.path || !v.path.startsWith('notifications.')) continue;
        const path = v.path.slice('notifications.'.length);
        const isSelf = path.startsWith(SELF_PREFIX);

        const value = v.value || {};
        const state = value.state;
        const prev = lastState.get(path);
        if (state === prev) continue;          // edge-trigger: act on change only
        lastState.set(path, state);

        try {
          if (shouldForward(state, minState)) {
            const row = {
              path,
              state,
              message: value.message,
              timestamp: value.timestamp,
              method: value.method,
            };
            publishMqtt(`${prefix}/${path}`, buildEnvelope(row, position()));
            // Our own delivery-path alarms still publish to MQTT (the only
            // path from the notifications tree to voice/dashboard) but are
            // never routed back out through classify/route — that would loop
            // through the very lane that is failing. Safe: the notification
            // carries method: ['visual'], so classify() can never assign it
            // a lane anyway, and an MQTT failure cannot re-raise past the
            // `raised` guard in recordResult.
            if (isSelf) continue;
            newlyActive.push(row);
          } else if (shouldForward(prev, minState)) {
            // Was being forwarded, no longer is. Gated on the PREVIOUS state
            // having been forwardable, not merely active: otherwise a path that
            // never published an active envelope gets a retained `normal` on a
            // topic that never existed.
            //
            // Cleared alarms publish to MQTT only — they never page and never
            // wake the agent.
            publishMqtt(`${prefix}/${path}`, buildEnvelope({ path, state: 'normal', message: 'cleared', timestamp: null }));
          }
        } catch (e) {
          app.error(`notification error for ${path}: ${e.message}`);
        }
      }
    }

    if (newlyActive.length) route(newlyActive);
  }

  plugin.start = function (options) {
    // Self-guarding: SignalK always calls stop() before a re-start today, but
    // unsubscribes is only reset in stop(). A start() without one first would
    // leave the previous subscription live alongside the new one — every
    // notification routed twice, a double siren.
    plugin.stop();
    currentOptions = options || {};
    lastState = new Map();
    pendingSoft = [];
    // Reset the consecutive-failure count — a stale streak from before the
    // restart shouldn't count toward the new threshold. Do NOT clear
    // `raised`: if a lane's alarm is currently active in the SignalK
    // notifications tree, forgetting that here would mean the next success
    // never calls setDeliveryFailed(lane, false) (recordResult only clears
    // when raised.has(lane)), latching the tree at `alert` until the whole
    // server restarts. `raised` is per-plugin-instance state; a real server
    // restart clears it naturally, which is the only reset it needs.
    failures.clear();
    failureThreshold = currentOptions.failureThreshold > 0 ? currentOptions.failureThreshold : 3;

    // A blank token and an expired one both fail silently, so a deploy that
    // forgets a field looks healthy and pages nobody. Say so loudly at start —
    // but keep running: a router with one broken lane is still worth having.
    if (!currentOptions.telegramBotToken || !currentOptions.telegramChatId) {
      app.error('no Telegram bot token/chat id — the hard lane (siren) will NOT deliver');
    }
    if (!currentOptions.hookUrl || !currentOptions.hookToken) {
      app.error('no agent hook URL/token — the soft lane will NOT deliver');
    }
    if (currentOptions.hookBodyExtra && !isJsonObject(currentOptions.hookBodyExtra)) {
      app.error(
        'hookBodyExtra is set but is not a JSON object — it will be ignored. ' +
        'Expected something like {"deliver":true,"channel":"telegram","to":"123456"}'
      );
    }
    if (!currentOptions.mqttUrl) {
      app.error('no MQTT broker URL — nothing will reach naturali/alerts/#');
    } else {
      mqttClient = senders.connectMqtt(currentOptions);
      if (mqttClient.on) mqttClient.on('error', (e) => app.error(`mqtt: ${e.message}`));
    }

    app.subscriptionmanager.subscribe(
      { context: 'vessels.self', subscribe: [{ path: 'notifications.*', policy: 'instant' }] },
      unsubscribes,
      (err) => app.error(err),
      (delta) => {
        try {
          onDelta(delta);
        } catch (e) {
          app.error(`signalk-notification-router: ${e.message}`);
        }
      }
    );
  };

  plugin.stop = function () {
    unsubscribes.forEach((f) => f());
    unsubscribes = [];
    lastState = new Map();
    pendingSoft = [];
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (mqttClient) { mqttClient.end(); mqttClient = null; }
  };

  return plugin;
};

// Pure helpers, hung off the factory for unit tests.
module.exports._internal = { rank, isActive, shouldForward, classify, buildEnvelope, shortPath, renderSiren, renderFollowupPrompt, renderAgentPrompt, sendTelegram, postHook, parseHookExtra, connectMqtt };
