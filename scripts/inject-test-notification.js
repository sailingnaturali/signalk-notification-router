#!/usr/bin/env node
/*
 * Inject a notification into a running SignalK server over the delta WebSocket.
 *
 * A PUT to /signalk/v1/api/vessels/self/notifications/... returns 404 — no
 * handler is registered for that path — so this is the way to exercise a lane
 * without waiting for a real sensor. Needs a user JWT (device tokens are fine
 * for data writes, but keep to the user JWT for consistency with the rest of
 * the tooling).
 *
 *   SIGNALK_TOKEN=... node scripts/inject-test-notification.js \
 *     --host naturalaspi --path test.softLane --state warn --method visual,sound \
 *     --message "TEST soft lane - ignore"
 *
 * Clear it by re-running with --state normal.
 */

// Global WebSocket is Node 22+. The plugin itself must stay Node-20-compatible
// for Cerbo GX, so this dev-only script falls back to the `ws` devDependency
// rather than raising the package's engines floor.
const WS = globalThis.WebSocket || require('ws');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith('--')) {
      const v = all[i + 1];
      acc.push([a.slice(2), v && !v.startsWith('--') ? v : undefined]);
    }
    return acc;
  }, [])
);

const VALID_STATES = ['alert', 'warn', 'alarm', 'emergency', 'normal'];
if (args.state && !VALID_STATES.includes(args.state)) {
  console.error(`--state must be one of: ${VALID_STATES.join(', ')}`);
  process.exit(1);
}

const host = args.host || 'localhost';
const token = process.env.SIGNALK_TOKEN;
if (!token) { console.error('SIGNALK_TOKEN is required'); process.exit(1); }

const value =
  args.state === 'normal'
    ? { state: 'normal', method: [], message: '' }
    : {
        state: args.state || 'warn',
        method: (args.method || 'visual,sound').split(','),
        message: args.message || 'TEST notification - ignore',
        timestamp: new Date().toISOString(),
      };

const ws = new WS(`ws://${host}:3000/signalk/v1/stream?subscribe=none`, {
  headers: { Authorization: `Bearer ${token}` },
});

const connectTimeout = setTimeout(() => {
  console.error(`timed out connecting to ${host} after 10s`);
  process.exit(1);
}, 10000);

ws.addEventListener('open', () => {
  clearTimeout(connectTimeout);
  ws.send(JSON.stringify({
    context: 'vessels.self',
    updates: [{
      source: { label: 'inject-test-notification' },
      timestamp: new Date().toISOString(),
      values: [{ path: `notifications.${args.path || 'test.injected'}`, value }],
    }],
  }));
  console.log(`sent notifications.${args.path || 'test.injected'} = ${value.state} [${value.method}]`);
  setTimeout(() => { ws.close(); process.exit(0); }, 500);
});

ws.addEventListener('error', (e) => { console.error('ws error:', e.message); process.exit(1); });
