import test from 'node:test';
import assert from 'node:assert/strict';
import { createPageBridge } from '../src/page-bridge.mjs';
import { HOST_MESSAGE_MARKER } from './fixtures/host-contract.mjs';

function fakeWindow() {
  const listeners = new Set();
  return {
    parent: null,
    document: { documentElement: { dataset: {}, style: { colorScheme: '', vars: {}, setProperty(key, value) { this.vars[key] = value; } } } },
    addEventListener(name, fn) { if (name === 'message') listeners.add(fn); },
    removeEventListener(name, fn) { if (name === 'message') listeners.delete(fn); },
    dispatch(event) { for (const fn of [...listeners]) fn(event); },
    get listenerCount() { return listeners.size; },
  };
}

test('bridge accepts only parent handshake and tracks theme plus host visibility', async () => {
  const self = fakeWindow();
  const sent = [];
  const parent = { postMessage: (message, target) => sent.push({ message, target }) };
  self.parent = parent;
  const themes = [];
  const visibility = [];
  const bridge = createPageBridge({ parentWindow: parent, selfWindow: self, timeoutMs: 100, onTheme: (theme) => themes.push(theme), onVisibility: (visible) => visibility.push(visible) });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.method, 'hello');
  const id = sent[0].message.id;
  self.dispatch({ source: {}, data: { [HOST_MESSAGE_MARKER]: 1, id, result: { dark: false } } });
  assert.equal(self.listenerCount, 1);
  self.dispatch({ source: parent, data: { [HOST_MESSAGE_MARKER]: 1, id, result: { dark: true, lang: 'zh-CN', tokens: { bg: '#101010', untrusted: 'bad' }, visible: true, service: '/_service/' } } });
  const result = await bridge.ready;
  assert.equal(result.theme.dark, true);
  assert.equal(self.document.documentElement.dataset.theme, 'dark');
  assert.equal(self.document.documentElement.style.vars[`--${HOST_MESSAGE_MARKER}-bg`], '#101010');
  assert.equal(self.document.documentElement.lang, 'zh-CN');
  assert.deepEqual(themes.map((x) => x.dark), [true]);
  self.dispatch({ source: parent, data: { [HOST_MESSAGE_MARKER]: 1, event: 'visibility', data: { visible: false } } });
  assert.equal(bridge.visible, false);
  assert.deepEqual(visibility, [false]);
  bridge.stop();
  assert.equal(self.listenerCount, 0);
});

test('bridge timeout fails closed and tears down its listener', async () => {
  const self = fakeWindow();
  const parent = { postMessage() {} };
  self.parent = parent;
  const bridge = createPageBridge({ parentWindow: parent, selfWindow: self, timeoutMs: 5 });
  await assert.rejects(bridge.ready, /timed out/);
  assert.equal(self.listenerCount, 0);
});
