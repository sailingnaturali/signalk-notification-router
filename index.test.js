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
  assert.equal(shortPath('dsc.distress.316012345-2026-08-07T18:22:10'), 'dsc.distress');
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
