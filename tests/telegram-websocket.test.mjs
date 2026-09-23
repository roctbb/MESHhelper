import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { telegramWebSocket } = require('../server/telegram-websocket.cjs');
const { telegramTransport } = require('../server/telegram-adapter.cjs');
const tick = () => new Promise(setImmediate);

function fixture() {
  const sockets = []; const agents = [];
  class Socket {
    constructor(url, protocol, options) { Object.assign(this, { url, protocol, options }); sockets.push(this); }
    terminate() { this.terminated = true; }
    send(data) { this.sent = data; }
  }
  const Transport = telegramWebSocket('socks5h://user:secret@proxy.example:1080', {
    WebSocketImpl: Socket,
    agentFactory: async (url) => {
      const agent = { url, destroy() { this.destroyed = true; } }; agents.push(agent); return agent;
    }
  });
  return { transport: new Transport(), sockets, agents };
}

test('proxy defaults to domain WebSockets; direct and explicit TCP stay available', () => {
  assert.deepEqual(telegramTransport({}), { proxy: undefined });
  const env = { TELEGRAM_PROXY_URL: 'socks5h://proxy.example:1080' };
  assert.equal(telegramTransport(env).networkSocket.isWebSocket, true);
  assert.equal(telegramTransport({ ...env, TELEGRAM_TRANSPORT: 'tcp' }).proxy.ip, 'proxy.example');
  assert.equal(telegramTransport({ TELEGRAM_TRANSPORT: 'wss' }).networkSocket.isWebSocket, true);
  assert.throws(() => telegramTransport({ TELEGRAM_TRANSPORT: 'bad' }), { status: 503 });
});

test('WSS preserves remote DNS proxy URL and binary streaming across frames', async () => {
  const { transport, sockets, agents } = fixture();
  const connecting = transport.connect(443, 'venus.web.telegram.org'); await tick();
  const socket = sockets[0]; socket.onopen(); await connecting;
  assert.equal(socket.url, 'wss://venus.web.telegram.org:443/apiws');
  assert.equal(socket.protocol, 'binary');
  assert.equal(socket.options.agent, agents[0]);
  assert.equal(agents[0].url, 'socks5h://user:secret@proxy.example:1080');
  assert.equal(socket.options.handshakeTimeout, 8000);
  const reading = transport.readExactly(5);
  socket.onmessage({ data: Uint8Array.from([1, 2]).buffer }); await tick();
  socket.onmessage({ data: Uint8Array.from([3, 4, 5, 6]).buffer });
  assert.deepEqual(await reading, Buffer.from([1, 2, 3, 4, 5]));
  assert.deepEqual(await transport.read(1), Buffer.from([6]));
  const pending = assert.rejects(transport.read(1), /closed/);
  await transport.close(); await pending;
  assert.equal(socket.terminated, true); assert.equal(agents[0].destroyed, true);
});

test('closing during handshake aborts the connection and releases resources', async () => {
  const { transport, sockets, agents } = fixture();
  const connecting = assert.rejects(transport.connect(443, 'pluto.web.telegram.org'), /failed/);
  await tick(); await transport.close(); await connecting;
  assert.equal(sockets[0].terminated, true); assert.equal(agents[0].destroyed, true);
});

test('proxy errors do not expose credentials and close blocked readers', async () => {
  const { transport, sockets, agents } = fixture();
  const connecting = assert.rejects(transport.connect(443, 'flora.web.telegram.org'), (err) => !err.message.includes('secret'));
  await tick(); sockets[0].onerror(new Error('proxy user:secret failed')); await connecting;
  assert.equal(transport.closed, true); assert.equal(agents[0].destroyed, true);
});

test('cancellation during agent creation cannot open a late socket', async () => {
  let finishAgent; let destroyed = false;
  const Transport = telegramWebSocket('socks5h://proxy.example:1080', {
    agentFactory: () => new Promise((resolve) => { finishAgent = resolve; }),
    WebSocketImpl: class { constructor() { assert.fail('late socket'); } }
  });
  const transport = new Transport();
  const connecting = assert.rejects(transport.connect(443, 'venus.web.telegram.org'), /closed/);
  await tick(); await transport.close();
  finishAgent({ destroy() { destroyed = true; } }); await connecting;
  assert.equal(destroyed, true);
});
