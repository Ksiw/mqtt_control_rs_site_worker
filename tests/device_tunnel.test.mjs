import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundled = await build({
  entryPoints: ['src/device_tunnel.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
});
const { DeviceTunnel } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

class FakeSocket {
  listeners = new Map();
  sent = [];
  accept() {}
  send(message) { this.sent.push(JSON.parse(message)); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  emit(name, value) { this.listeners.get(name)?.({ data: JSON.stringify(value) }); }
}

test('operator event response forwards chunks and cancels the local stream', async () => {
  const tunnel = new DeviceTunnel({}, {});
  const socket = new FakeSocket();
  tunnel.setupDeviceWebSocket(socket);

  const responsePromise = tunnel.fetch(new Request('https://tunnel.internal/operator/events'));
  const id = socket.sent[0].id;
  assert.equal(socket.sent[0].path, '/operator/events');
  socket.emit('message', {
    type: 'http_response_start', id, status: 200,
    headers: { 'content-type': 'text/event-stream', 'content-length': '999' },
  });
  const response = await responsePromise;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), null);

  const reader = response.body.getReader();
  const payload = 'event: view\ndata: {"view":1}\n\n';
  socket.emit('message', {
    type: 'http_response_chunk', id, data: Buffer.from(payload).toString('base64'),
  });
  assert.equal(new TextDecoder().decode((await reader.read()).value), payload);
  await reader.cancel();
  assert.equal(socket.sent.at(-1).type, 'http_cancel');
  assert.equal(socket.sent.at(-1).id, id);
  assert.equal(tunnel.activeStreams.size, 0);
});

test('ordinary requests keep the single response protocol', async () => {
  const tunnel = new DeviceTunnel({}, {});
  const socket = new FakeSocket();
  tunnel.setupDeviceWebSocket(socket);
  const responsePromise = tunnel.fetch(new Request('https://tunnel.internal/operator/view'));
  const id = socket.sent[0].id;
  socket.emit('message', {
    type: 'http_response', id, status: 200,
    headers: { 'content-type': 'application/json' }, body: '{"view":1}',
  });
  const response = await responsePromise;
  assert.deepEqual(await response.json(), { view: 1 });
});
