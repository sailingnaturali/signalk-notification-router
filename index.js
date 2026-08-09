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
const SEVERITY = { nominal: 0, normal: 1, alert: 2, warn: 3, alarm: 4, emergency: 5 };
const INACTIVE = new Set(['nominal', 'normal']);

function rank(state) {
  return state in SEVERITY ? SEVERITY[state] : -1;
}
function isActive(state) {
  return state != null && !INACTIVE.has(state);
}
function shouldForward(state, minState) {
  return isActive(state) && rank(state) >= rank(minState);
}

module.exports = function (app, deps) {
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
  let failureThreshold = 3;
  let consecutiveFailures = 0;
  let deliveryFailedRaised = false;

  function setDeliveryFailed(active, detail) {
    app.handleMessage(plugin.id, {
      updates: [{ values: [{ path: DELIVERY_FAILED_PATH, value: active
        ? {
            state: 'alert',
            method: ['visual'],
            message: `ntfy delivery path failing${detail ? ` (${detail})` : ''} — alarms are not reaching the phone`,
            timestamp: new Date().toISOString(),
          }
        : { state: 'normal', method: [], message: '' } }] }],
    });
  }

  // Shared by the reactive (per-send) and proactive (heartbeat) paths: a run of
  // `failureThreshold` consecutive failures raises the delivery-path alarm; any
  // success resets and clears it.
  function recordResult(ok, detail) {
    if (ok) {
      consecutiveFailures = 0;
      if (deliveryFailedRaised) { deliveryFailedRaised = false; setDeliveryFailed(false); }
      return;
    }
    consecutiveFailures += 1;
    if (consecutiveFailures >= failureThreshold && !deliveryFailedRaised) {
      deliveryFailedRaised = true;
      setDeliveryFailed(true, detail);
    }
  }

  function position() {
    const node = app.getSelfPath('navigation.position');
    if (node == null) return undefined;
    const v = typeof node === 'object' && 'value' in node ? node.value : node;
    return v && typeof v.latitude === 'number' ? v : undefined;
  }

  function onDelta(delta, options) {
    (delta.updates || []).forEach((u) =>
      (u.values || []).forEach((v) => {
        if (!v.path || !v.path.startsWith('notifications.')) return;
        const state = v.value && v.value.state;
        const path = v.path.slice('notifications.'.length);
        // Never forward our own delivery-path alarm — it must not loop through
        // the failing ntfy path (it surfaces via the dashboard/voice instead).
        if (path.startsWith('ntfyRelay.')) return;
        const prev = lastState.get(path);
        if (state === prev) return; // edge-trigger: only act on change
        lastState.set(path, state);
        const min = options.minState || 'warn';
        const message = (v.value && v.value.message) || undefined;
        const onResult = (ok) => recordResult(ok, ok ? undefined : 'send failed');
        if (shouldForward(state, min)) {
          send(buildRequest({ path, state, message }, position(), options), app, onResult);
        } else if (
          !isActive(state) &&
          isActive(prev) &&
          options.notifyOnClear !== false
        ) {
          send(
            buildRequest({ path, state: state || 'normal', message }, position(), options),
            app,
            onResult
          );
        }
      })
    );
  }

  plugin.start = function (options) {
    options = options || {};
    lastState = new Map();
    currentOptions = options;
    failureThreshold = options.failureThreshold > 0 ? options.failureThreshold : 3;
    consecutiveFailures = 0;
    deliveryFailedRaised = false;
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
module.exports._internal = { rank, isActive, shouldForward };
