const test = require('node:test');
const assert = require('node:assert/strict');
const createPlugin = require('./index.js');
const { rank, isActive, shouldForward, classify } = createPlugin._internal;

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
