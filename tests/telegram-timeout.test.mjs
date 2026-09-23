import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { telegramRequest } from '../web/js/telegram-api.js';
const require = createRequire(import.meta.url);
const { withTelegramDeadlines } = require('../server/telegram-deadline.cjs');
const { createTelegramService, publicError } = require('../server/telegram-service.cjs');
const { telegramProxy } = require('../server/telegram-adapter.cjs');
const never = () => new Promise(() => {});

test('unreachable connect and hanging cleanup cannot hold login or send a code after timing out', async (t) => {
  let finishConnect; let codes = 0; let cleanups = 0;
  const service = createTelegramService({ env: { TELEGRAM_API_ID: '123', TELEGRAM_API_HASH: 'a'.repeat(32) }, operationTimeoutMs: 15,
    adapterFactory: () => ({ connect: () => new Promise((resolve) => { finishConnect = resolve; }),
      disconnect: () => { cleanups++; return never(); }, sendCode: () => { codes++; } }) });
  t.after(() => service.close());
  await assert.rejects(service.handle('login', { phone: '+79990000000' }), (err) => {
    assert.equal(err.status, 504); assert.equal(err.stage, 'connect');
    assert.match(publicError(err).error, /SOCKS5/); return true;
  });
  finishConnect(); await new Promise(setImmediate);
  assert.equal(codes, 0); assert.ok(cleanups >= 1);
});

test('code request timeout is bounded and is never automatically retried', async () => {
  let requests = 0; let closed = 0;
  const client = withTelegramDeadlines({ sendCode: () => { requests++; return never(); }, disconnect: async () => { closed++; } }, { timeoutMs: 10 });
  await assert.rejects(client.sendCode('+79990000000'), { status: 504, stage: 'sendCode', restartLogin: true });
  await assert.rejects(client.sendCode('+79990000000'), { status: 504 });
  assert.equal(requests, 1); assert.equal(closed, 1);
});

test('fast network failure reports the server route problem without exposing SDK internals', async () => {
  const client = withTelegramDeadlines({ connect: async () => { throw new Error('Socket failed private-key-details'); }, disconnect: async () => {} });
  await assert.rejects(client.connect(), (err) => {
    const result = publicError(err); assert.equal(result.status, 502);
    assert.match(result.error, /Сервер/); assert.ok(!result.error.includes('private-key')); return true;
  });
});

test('RPC validation errors are preserved rather than mislabeled as network failures', async () => {
  const rpcError = Object.assign(new Error('PHONE_CODE_INVALID'), { errorMessage: 'PHONE_CODE_INVALID' });
  const client = withTelegramDeadlines({ signIn: async () => { throw rpcError; }, disconnect: async () => {} });
  await assert.rejects(client.signIn(), (err) => err === rpcError);
  assert.equal(client.unavailable, false);
  const apiError = Object.assign(new Error('API_ID_INVALID'), { errorMessage: 'API_ID_INVALID' });
  const failingConnect = withTelegramDeadlines({ connect: async () => { throw apiError; }, disconnect: async () => {} });
  await assert.rejects(failingConnect.connect(), (err) => err === apiError);
});

test('frontend aborts a stalled fetch and does not retry authentication', async () => {
  let calls = 0;
  await assert.rejects(telegramRequest('login', {}, '', { timeoutMs: 10, fetchImpl: (_url, options) => {
    calls++; return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))));
  } }), /Сервер не ответил вовремя/);
  assert.equal(calls, 1);
});

test('frontend timeout also covers the response body and warns that a broadcast may have started', async () => {
  await assert.rejects(telegramRequest('send', {}, '', { timeoutMs: 10, fetchImpl: async (_url, options) => ({ ok: true,
    json: () => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))))
  }) }), /Рассылка могла запуститься/);
});

test('frontend understands reverse proxy HTML errors and server login reset responses', async () => {
  await assert.rejects(telegramRequest('login', {}, '', { fetchImpl: async () => ({ status: 504, ok: false, json: async () => { throw new SyntaxError(); } }) }), /HTTP 504/);
  await assert.rejects(telegramRequest('code', {}, '', { fetchImpl: async () => ({ status: 504, ok: false,
    json: async () => ({ error: 'Telegram timeout', restartLogin: true }) }) }), { restartLogin: true, status: 504 });
});

test('SOCKS5 configuration is explicit, validated, and supports authenticated proxies', () => {
  assert.equal(telegramProxy({ HTTPS_PROXY: 'https://unused' }), undefined);
  assert.deepEqual(telegramProxy({ TELEGRAM_PROXY_URL: 'socks5://example-user:example-password@proxy.internal:1080' }),
  { ip: 'proxy.internal', port: 1080, socksType: 5, timeout: 8, username: 'example-user', password: 'example-password' });
  assert.deepEqual(telegramProxy({ TELEGRAM_PROXY_URL: 'socks5h://proxy.internal:1080' }),
    { ip: 'proxy.internal', port: 1080, socksType: 5, timeout: 8, username: undefined, password: undefined });
  assert.equal(telegramProxy({ TELEGRAM_PROXY_URL: 'socks5://user:p%40ss%23word@[::1]:1081' }).password, 'p@ss#word');
  assert.equal(telegramProxy({ TELEGRAM_PROXY_URL: 'socks5://[::1]:1081' }).ip, '::1');
  assert.equal(telegramProxy({ TELEGRAM_PROXY_URL: 'socks5h://user:p%40ss%23word@proxy.internal:1080' }).password, 'p@ss#word');
  for (const url of ['https://secret@proxy.internal', 'socks5://proxy.internal', 'socks5://proxy.internal:0', 'socks5://user:secret@proxy.internal:1080/path', 'socks5://user:p%xx@proxy.internal:1080']) {
    assert.throws(() => telegramProxy({ TELEGRAM_PROXY_URL: url }), (err) => err.status === 503 && !err.message.includes('secret'));
  }
});
