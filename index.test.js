const test = require('node:test');
const assert = require('node:assert/strict');
const createPlugin = require('./index.js');
const { rank, isActive, shouldForward, classify, buildEnvelope, shortPath, renderSiren, renderFollowupPrompt, renderAgentPrompt } = createPlugin._internal;

test('rank orders the SignalK severity ladder', () => {
  assert.ok(rank('emergency') > rank('alarm'));
  assert.ok(rank('alarm') > rank('warn'));
  assert.ok(rank('warn') > rank('alert'));
  assert.equal(rank('bogus'), -1);
});

test('isActive: nominal/normal are inactive, the rest active', () => {
  assert.equal(isActive('normal'), false);
  assert.equal(isActive('nominal'), false);
  assert.equal(isActive(undefined), false);
  assert.equal(isActive('warn'), true);
  assert.equal(isActive('emergency'), true);
});

test('shouldForward: active and >= minState', () => {
  assert.equal(shouldForward('emergency', 'warn'), true);
  assert.equal(shouldForward('warn', 'warn'), true);
  assert.equal(shouldForward('alert', 'warn'), false); // below min
  assert.equal(shouldForward('normal', 'warn'), false); // inactive
  assert.equal(shouldForward('alarm', 'alarm'), true);
});

test('classify: hard lane requires sound', () => {
  assert.equal(classify('alarm', ['visual', 'sound']), 'hard');
  assert.equal(classify('emergency', ['visual', 'sound']), 'hard');
});

test('classify: soft lane requires sound', () => {
  assert.equal(classify('warn', ['visual', 'sound']), 'soft');
  assert.equal(classify('alert', ['visual', 'sound']), 'soft');
});

test('classify: no sound never pushes, at any severity', () => {
  // The publisher asked for display only. Honour it even for emergency.
  assert.equal(classify('emergency', ['visual']), null);
  assert.equal(classify('alarm', ['visual']), null);
  assert.equal(classify('warn', ['visual']), null);
});

test('classify: missing or malformed method never pushes', () => {
  assert.equal(classify('alarm', undefined), null);
  assert.equal(classify('alarm', null), null);
  assert.equal(classify('alarm', []), null);
  assert.equal(classify('alarm', 'sound'), null);          // string, not an array
  assert.equal(classify('alarm', { sound: true }), null);  // object, not an array
});

test('classify: inactive and unknown states never push', () => {
  assert.equal(classify('normal', ['sound']), null);
  assert.equal(classify('nominal', ['sound']), null);
  assert.equal(classify(undefined, ['sound']), null);
  assert.equal(classify('bogus', ['sound']), null);
});

const HARD_ENV = {
  path: 'navigation.anchor',
  state: 'alarm',
  message: 'Anchor dragging',
  timestamp: '2026-08-06T22:14:03Z',
  position: { latitude: 48.76021, longitude: -123.05213 },
};

test('buildEnvelope includes position when known', () => {
  const env = buildEnvelope(
    { path: 'mob.1', state: 'emergency', message: 'MOB', timestamp: 't' },
    { latitude: 48.76, longitude: -123.05 }
  );
  assert.deepEqual(env, {
    path: 'mob.1', state: 'emergency', message: 'MOB', timestamp: 't',
    position: { latitude: 48.76, longitude: -123.05 },
  });
});

test('buildEnvelope omits position when absent or non-numeric', () => {
  const row = { path: 'a', state: 'alarm', message: 'm', timestamp: 't' };
  assert.equal('position' in buildEnvelope(row, undefined), false);
  assert.equal('position' in buildEnvelope(row, { latitude: 48.76 }), false);
  assert.equal('position' in buildEnvelope(row, { latitude: 48.76, longitude: 'x' }), false);
});

test('buildEnvelope emits null, not undefined, for a missing message', () => {
  // JSON.stringify drops undefined keys; Python emitted null. HA parses it.
  const env = buildEnvelope({ path: 'a', state: 'alarm' }, undefined);
  assert.equal(env.message, null);
  assert.equal(env.timestamp, null);
  assert.equal(JSON.parse(JSON.stringify(env)).message, null);
});

test('buildEnvelope drops method — it is not part of the MQTT contract', () => {
  const env = buildEnvelope(
    { path: 'a', state: 'alarm', message: 'm', timestamp: 't', method: ['sound'] },
    undefined
  );
  assert.equal('method' in env, false);
});

test('shortPath drops id-length segments and keeps the meaning', () => {
  // The real DSC path shape, milliseconds included. The timestamped id
  // segment is dropped, but the trailing millisecond fragment ('114Z') is
  // under the 20-char threshold and survives — so the siren reads
  // 'dsc.distress.114Z'. Verified identical in the Python original; this
  // test documents the quirk rather than hiding it behind a trimmed input.
  assert.equal(shortPath('dsc.distress.316012345-2026-08-07T18:22:10.114Z'), 'dsc.distress.114Z');
  assert.equal(shortPath('navigation.anchor'), 'navigation.anchor');
  assert.equal(shortPath('mob.1'), 'mob.1');
});

test('shortPath falls back when every segment is long', () => {
  const long = 'aaaaaaaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbbbbb';
  assert.equal(shortPath(long), long);
});

test('shortPath never throws on null or a non-string', () => {
  assert.equal(typeof shortPath(null), 'string');
  assert.equal(typeof shortPath(42), 'string');
});

test('shortPath keeps short segments that follow a long one', () => {
  // Filters every id-length segment out rather than truncating at the first
  // one. Ported verbatim from the Python original, where this is a list
  // comprehension over all segments — a break-at-first-long variant would
  // return 'a' here and silently differ on any path shaped this way.
  assert.equal(shortPath(`a.${'X'.repeat(21)}.b`), 'a.b');
});

test('renderSiren leads with state and path, then message and position', () => {
  const text = renderSiren(HARD_ENV);
  assert.match(text, /ALARM/);
  assert.match(text, /navigation\.anchor/);
  assert.match(text, /Anchor dragging/);
  assert.match(text, /48\.76021/);
  assert.match(text, /-123\.05213/);
});

test('renderSiren survives a missing message and position', () => {
  const text = renderSiren({ path: 'tanks.bilge', state: 'emergency' });
  assert.match(text, /EMERGENCY/);
  assert.match(text, /tanks\.bilge/);
});

test('renderSiren shortens the path but keeps the full message', () => {
  const text = renderSiren({
    path: 'dsc.distress.316012345-2026-08-07T18:22:10.114Z',
    state: 'emergency',
    message: 'DSC distress from a vessel 3.2 nm north',
  });
  assert.match(text, /dsc\.distress/);
  assert.equal(text.includes('316012345-2026'), false);
  assert.match(text, /3\.2 nm north/);
});

test('renderFollowupPrompt names the alarm and says it was already sent', () => {
  const prompt = renderFollowupPrompt(HARD_ENV);
  assert.match(prompt, /navigation\.anchor/);
  assert.match(prompt, /already/i);
  assert.equal(/alarm alarm/i.test(prompt), false);   // no doubled wording
});

test('renderAgentPrompt lists every row and says the Captain has NOT been told', () => {
  const prompt = renderAgentPrompt([
    { path: 'tanks.blackWater.0', state: 'warn', message: 'Tank 87%' },
    { path: 'electrical.batteries.house', state: 'alert', message: 'SOC 48%' },
  ]);
  assert.match(prompt, /tanks\.blackWater\.0/);
  assert.match(prompt, /electrical\.batteries\.house/);
  assert.match(prompt, /warn/);
  assert.match(prompt, /alert/);
  assert.match(prompt, /NOT/);
});

test('renderAgentPrompt survives rows with no message', () => {
  assert.match(renderAgentPrompt([{ path: 'x.y', state: 'warn' }]), /x\.y/);
});

const { sendTelegram, postHook } = createPlugin._internal;

function fakeFetch(record, response) {
  return async (url, init) => {
    record.push({ url, init });
    return { ok: response.ok, status: response.status };
  };
}

test('sendTelegram posts to the bot API with the chat id and text', async () => {
  const calls = [];
  await sendTelegram('hello', {
    telegramBotToken: 'BOTTOKEN',
    telegramChatId: '5585762270',
    fetch: fakeFetch(calls, { ok: true, status: 200 }),
  });
  assert.equal(calls[0].url, 'https://api.telegram.org/botBOTTOKEN/sendMessage');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    chat_id: '5585762270',
    text: 'hello',
  });
});

test('sendTelegram error never leaks the bot token', async () => {
  const calls = [];
  await assert.rejects(
    () => sendTelegram('hello', {
      telegramBotToken: 'SUPERSECRET123',
      telegramChatId: '1',
      fetch: fakeFetch(calls, { ok: false, status: 401 }),
    }),
    (e) => {
      assert.equal(e.message.includes('SUPERSECRET123'), false);
      assert.match(e.message, /401/);
      return true;
    }
  );
});

test('postHook sends the bearer token and the message', async () => {
  const calls = [];
  await postHook('investigate', {
    hookUrl: 'http://127.0.0.1:18789/hooks-x/agent',
    hookToken: 'TOK',
    fetch: fakeFetch(calls, { ok: true, status: 200 }),
  });
  assert.equal(calls[0].url, 'http://127.0.0.1:18789/hooks-x/agent');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer TOK');
  assert.deepEqual(JSON.parse(calls[0].init.body), { message: 'investigate' });
});

test('postHook throws on a non-2xx so the lane is recorded as failed', async () => {
  await assert.rejects(() =>
    postHook('x', {
      hookUrl: 'http://h/agent',
      hookToken: 't',
      fetch: fakeFetch([], { ok: false, status: 503 }),
    })
  );
});

test('sendTelegram never leaks the bot token when fetch itself rejects', async () => {
  const boom = async () => { throw new Error('connect ECONNREFUSED https://api.telegram.org/botSUPERSECRET123/sendMessage'); };
  await assert.rejects(
    () => sendTelegram('hello', { telegramBotToken: 'SUPERSECRET123', telegramChatId: '1', fetch: boom }),
    (e) => {
      assert.equal(e.message.includes('SUPERSECRET123'), false);
      return true;
    }
  );
});

function fakeApp() {
  const handled = [];
  const errors = [];
  let handler = null;
  return {
    handled,
    errors,
    // Feed a delta into whatever the plugin subscribed with.
    emit: (values) => handler({ updates: [{ values }] }),
    handleMessage: (_id, msg) => handled.push(msg),
    error: (e) => errors.push(String(e)),
    debug: () => {},
    getSelfPath: () => ({ value: { latitude: 48.76, longitude: -123.05 } }),
    subscriptionmanager: {
      subscribe: (_sub, _unsubs, _onErr, onDelta) => { handler = onDelta; },
    },
  };
}

function startPlugin(app, overrides = {}, options = {}) {
  const sent = { telegram: [], hook: [], mqtt: [] };
  const plugin = createPlugin(app, {
    sendTelegram: async (text) => { sent.telegram.push(text); },
    postHook: async (message) => { sent.hook.push(message); },
    connectMqtt: () => ({
      publish: (topic, payload, _o, cb) => { sent.mqtt.push([topic, JSON.parse(payload)]); cb(); },
      end: () => {},
    }),
    ...overrides,
  });
  plugin.start({
    minState: 'alert',
    coalesceSeconds: 10,
    topicPrefix: 'naturali/alerts',
    mqttUrl: 'mqtt://localhost:1883',
    telegramBotToken: 't', telegramChatId: 'c',
    hookUrl: 'http://h/agent', hookToken: 'k',
    ...options,
  });
  return { plugin, sent };
}

const SOUND = ['visual', 'sound'];

const settle = () => new Promise((r) => setImmediate(r));

test('a forwardable notification publishes a retained MQTT envelope', async () => {
  const app = fakeApp();
  const { sent } = startPlugin(app);
  app.emit([{ path: 'notifications.mob.1', value: { state: 'emergency', message: 'MOB', timestamp: 't', method: SOUND } }]);
  await settle();
  assert.equal(sent.mqtt[0][0], 'naturali/alerts/mob.1');
  assert.deepEqual(sent.mqtt[0][1], {
    path: 'mob.1', state: 'emergency', message: 'MOB', timestamp: 't',
    position: { latitude: 48.76, longitude: -123.05 },
  });
});

test('an unchanged state re-delivered is edge-triggered away', async () => {
  const app = fakeApp();
  const { sent } = startPlugin(app);
  const v = [{ path: 'notifications.mob.1', value: { state: 'emergency', timestamp: 't', method: SOUND } }];
  app.emit(v);
  app.emit(v);
  await settle();
  assert.equal(sent.mqtt.length, 1);
  assert.equal(sent.telegram.length, 1);
});

test('the hard lane sirens immediately and posts a follow-up', async () => {
  const app = fakeApp();
  const { sent } = startPlugin(app);
  app.emit([{ path: 'notifications.navigation.anchor', value: { state: 'alarm', message: 'Dragging', timestamp: 't', method: SOUND } }]);
  await settle();
  assert.equal(sent.telegram.length, 1);
  assert.match(sent.telegram[0], /ALARM/);
  assert.match(sent.telegram[0], /48\.76000/);
  assert.equal(sent.hook.length, 1);
  assert.match(sent.hook[0], /already been sent/);
});

test('the hard lane never coalesces', async () => {
  const app = fakeApp();
  const { sent } = startPlugin(app);
  app.emit([
    { path: 'notifications.a', value: { state: 'alarm', timestamp: 't', method: SOUND } },
    { path: 'notifications.b', value: { state: 'emergency', timestamp: 't', method: SOUND } },
  ]);
  await settle();
  assert.equal(sent.telegram.length, 2);
});

test('the soft lane waits for the window, batches, and never sirens', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const app = fakeApp();
  const { sent } = startPlugin(app);
  app.emit([{ path: 'notifications.tanks.blackWater.0', value: { state: 'warn', message: '87%', timestamp: 't', method: SOUND } }]);
  await settle();
  assert.deepEqual(sent.hook, []);          // held inside the window
  app.emit([{ path: 'notifications.electrical.batteries.house', value: { state: 'alert', message: 'SOC 48%', timestamp: 't', method: SOUND } }]);
  await settle();
  assert.deepEqual(sent.hook, []);
  t.mock.timers.tick(10000);
  await settle();
  assert.equal(sent.telegram.length, 0);    // the soft lane NEVER sirens
  assert.equal(sent.hook.length, 1);        // one batch, both rows
  assert.match(sent.hook[0], /tanks\.blackWater\.0/);
  assert.match(sent.hook[0], /electrical\.batteries\.house/);
});

test('the soft window runs from the oldest row, so a trickle still flushes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const app = fakeApp();
  const { sent } = startPlugin(app);
  app.emit([{ path: 'notifications.a', value: { state: 'warn', timestamp: 't', method: SOUND } }]);
  t.mock.timers.tick(6000);
  app.emit([{ path: 'notifications.b', value: { state: 'warn', timestamp: 't', method: SOUND } }]);
  t.mock.timers.tick(6000);                 // 12 s since the oldest — must fire
  await settle();
  assert.equal(sent.hook.length, 1);
  assert.match(sent.hook[0], /- a = warn/);
  assert.match(sent.hook[0], /- b = warn/);
});

test('a visual-only notification reaches MQTT and stops there', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const app = fakeApp();
  const { sent } = startPlugin(app);
  app.emit([{ path: 'notifications.navigation.restrictedArea.abc', value: { state: 'warn', message: 'Inside SRKW zone', timestamp: 't', method: ['visual'] } }]);
  t.mock.timers.tick(60000);
  await settle();
  assert.equal(sent.mqtt.length, 1);
  assert.deepEqual(sent.telegram, []);
  assert.deepEqual(sent.hook, []);
});

test('a path that escalates to hard drops its stale pending soft prompt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const app = fakeApp();
  const { sent } = startPlugin(app);
  app.emit([{ path: 'notifications.tanks.bilge', value: { state: 'warn', message: 'rising', timestamp: 't', method: SOUND } }]);
  app.emit([{ path: 'notifications.tanks.bilge', value: { state: 'alarm', message: 'flooding', timestamp: 't2', method: SOUND } }]);
  t.mock.timers.tick(10000);
  await settle();
  assert.equal(sent.telegram.length, 1);
  assert.match(sent.telegram[0], /ALARM/);
  assert.equal(sent.hook.length, 1);                    // the follow-up only
  assert.match(sent.hook[0], /already been sent/);
  assert.equal(/NOT been told/.test(sent.hook[0]), false);
});

test('a warn and an alarm for one path in the same batch drops the warn', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const app = fakeApp();
  const { sent } = startPlugin(app);
  app.emit([
    { path: 'notifications.tanks.bilge', value: { state: 'warn', timestamp: 't', method: SOUND } },
    { path: 'notifications.tanks.bilge', value: { state: 'alarm', timestamp: 't2', method: SOUND } },
  ]);
  t.mock.timers.tick(10000);
  await settle();
  assert.equal(sent.hook.filter((h) => /NOT been told/.test(h)).length, 0);
});

test('a hard row does not drop a pending soft row for a different path', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const app = fakeApp();
  const { sent } = startPlugin(app);
  app.emit([{ path: 'notifications.tanks.blackWater.0', value: { state: 'warn', timestamp: 't', method: SOUND } }]);
  app.emit([{ path: 'notifications.navigation.anchor', value: { state: 'alarm', timestamp: 't', method: SOUND } }]);
  t.mock.timers.tick(10000);
  await settle();
  assert.equal(sent.hook.filter((h) => /tanks\.blackWater\.0/.test(h)).length, 1);
});

test('a cleared notification publishes a normal envelope and routes nothing', async () => {
  const app = fakeApp();
  const { sent } = startPlugin(app);
  app.emit([{ path: 'notifications.mob.1', value: { state: 'emergency', timestamp: 't', method: SOUND } }]);
  await settle();
  sent.telegram.length = 0; sent.hook.length = 0;
  app.emit([{ path: 'notifications.mob.1', value: { state: 'normal' } }]);
  await settle();
  assert.deepEqual(sent.mqtt[1], ['naturali/alerts/mob.1', {
    path: 'mob.1', state: 'normal', message: 'cleared', timestamp: null,
  }]);
  assert.deepEqual(sent.telegram, []);
  assert.deepEqual(sent.hook, []);
});

test('a null value clears the same way a normal state does', async () => {
  const app = fakeApp();
  const { sent } = startPlugin(app);
  app.emit([{ path: 'notifications.mob.1', value: { state: 'emergency', timestamp: 't', method: SOUND } }]);
  await settle();
  app.emit([{ path: 'notifications.mob.1', value: null }]);
  await settle();
  assert.equal(sent.mqtt[1][1].state, 'normal');
});

test('a never-forwarded path does not emit a cleared envelope', async () => {
  const app = fakeApp();
  const { sent } = startPlugin(app, {}, { minState: 'alarm' });
  app.emit([{ path: 'notifications.x.y', value: { state: 'warn', timestamp: 't', method: SOUND } }]);
  app.emit([{ path: 'notifications.x.y', value: { state: 'normal' } }]);
  await settle();
  assert.deepEqual(sent.mqtt, []);
});

test('the plugin never routes its own deliveryFailed alarm', async () => {
  const app = fakeApp();
  const { sent } = startPlugin(app);
  app.emit([{ path: 'notifications.notificationRouter.deliveryFailed.telegram', value: { state: 'alert', method: ['visual', 'sound'], timestamp: 't' } }]);
  await settle();
  assert.deepEqual(sent.mqtt, []);
  assert.deepEqual(sent.telegram, []);
  assert.deepEqual(sent.hook, []);
});

test('a dead Telegram still lets the hook through, and vice versa', async () => {
  const app = fakeApp();
  const a = startPlugin(app, { sendTelegram: async () => { throw new Error('telegram down'); } });
  app.emit([{ path: 'notifications.navigation.anchor', value: { state: 'alarm', timestamp: 't', method: SOUND } }]);
  await settle();
  assert.equal(a.sent.hook.length, 1);

  const app2 = fakeApp();
  const b = startPlugin(app2, { postHook: async () => { throw new Error('gateway down'); } });
  app2.emit([{ path: 'notifications.navigation.anchor', value: { state: 'alarm', timestamp: 't', method: SOUND } }]);
  await settle();
  assert.equal(b.sent.telegram.length, 1);
});

test('a hung hook does not delay a later row\'s siren', async () => {
  // The failure the hard lane exists to survive. If route ever awaited its
  // deliveries, the second row's siren would be stuck behind the first
  // row's never-resolving hook POST.
  const app = fakeApp();
  let releaseHook;
  const { sent } = startPlugin(app, {
    postHook: () => new Promise((resolve) => { releaseHook = resolve; }),
  });
  app.emit([
    { path: 'notifications.a', value: { state: 'alarm', timestamp: 't', method: SOUND } },
    { path: 'notifications.b', value: { state: 'emergency', timestamp: 't', method: SOUND } },
  ]);
  await settle();
  assert.equal(sent.telegram.length, 2);   // both sirens out while the hook hangs
  releaseHook();
});

test('N consecutive Telegram failures raise a visual-only deliveryFailed alarm', async () => {
  const app = fakeApp();
  startPlugin(app, { sendTelegram: async () => { throw new Error('down'); } }, { failureThreshold: 2 });
  for (const p of ['a', 'b']) {
    app.emit([{ path: `notifications.${p}`, value: { state: 'alarm', timestamp: 't', method: SOUND } }]);
    await settle();
  }
  const raised = app.handled.flatMap((m) => m.updates[0].values)
    .filter((v) => v.path === 'notifications.notificationRouter.deliveryFailed.telegram');
  assert.equal(raised.length, 1);
  assert.equal(raised[0].value.state, 'alert');
  assert.deepEqual(raised[0].value.method, ['visual']);
});

test('a success after failures clears the deliveryFailed alarm', async () => {
  const app = fakeApp();
  let fail = true;
  startPlugin(app, { sendTelegram: async () => { if (fail) throw new Error('down'); } }, { failureThreshold: 1 });
  app.emit([{ path: 'notifications.a', value: { state: 'alarm', timestamp: 't', method: SOUND } }]);
  await settle();
  fail = false;
  app.emit([{ path: 'notifications.b', value: { state: 'alarm', timestamp: 't', method: SOUND } }]);
  await settle();
  const events = app.handled.flatMap((m) => m.updates[0].values)
    .filter((v) => v.path === 'notifications.notificationRouter.deliveryFailed.telegram');
  assert.equal(events.at(-1).value.state, 'normal');
});

test('a broken row does not abort the rest of the batch', async () => {
  const app = fakeApp();
  const { sent } = startPlugin(app);
  app.emit([
    { path: 'notifications.bad', value: { state: 'alarm', timestamp: 't', method: SOUND, get message() { throw new Error('boom'); } } },
    { path: 'notifications.good', value: { state: 'alarm', message: 'ok', timestamp: 't', method: SOUND } },
  ]);
  await settle();
  assert.equal(sent.telegram.filter((t) => /good/.test(t)).length, 1);
  assert.ok(app.errors.length >= 1);
});

test('stop() clears state so a restart does not replay', async () => {
  const app = fakeApp();
  const { plugin, sent } = startPlugin(app);
  app.emit([{ path: 'notifications.a', value: { state: 'alarm', timestamp: 't', method: SOUND } }]);
  await settle();
  assert.equal(sent.telegram.length, 1);

  plugin.stop();
  plugin.start({
    minState: 'alert', coalesceSeconds: 10, topicPrefix: 'naturali/alerts',
    mqttUrl: 'mqtt://localhost:1883', telegramBotToken: 't', telegramChatId: 'c',
    hookUrl: 'http://h/agent', hookToken: 'k',
  });
  // lastState was cleared, so the same notification is new again and sirens
  // once more — exactly once. A leaked subscription or timer would double it.
  app.emit([{ path: 'notifications.a', value: { state: 'alarm', timestamp: 't', method: SOUND } }]);
  await settle();
  assert.equal(sent.telegram.length, 2);
});
