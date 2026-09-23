import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('../', import.meta.url));
const source = readFileSync(new URL('../web-service.js', import.meta.url), 'utf8');

function fixture() {
  let handler; let handled = 0;
  runInNewContext(source, { __dirname: root, URL, process: { env: {} }, console: { log() {} },
    require(name) {
      if (name === 'dotenv') return { config() {} };
      if (name === 'http') return { createServer(fn) { handler = fn; return { listen() {} }; } };
      if (name === './server/telegram-service.cjs') return {
        createTelegramService: () => ({ async handle(action, body, token) { handled++; return { action, token, body }; } }),
        publicError: () => ({ status: 400, error: 'Invalid request' })
      };
      return require(name);
    }
  });
  return { count: () => handled, async send({ method = 'POST', headers = {}, url = '/api/telegram/state', payload = '{}' } = {}) {
    const req = Object.assign(new EventEmitter(), { method, url, socket: { remoteAddress: '127.0.0.1' },
      headers: { 'content-type': 'application/json', ...headers } });
    const result = { headers: {} };
    const res = { setHeader: (key, value) => { result.headers[key] = value; }, end: (data) => { result.body = JSON.parse(data); } };
    const pending = handler(req, res); req.emit('data', payload); req.emit('end'); await pending;
    return { ...result, status: res.statusCode };
  } };
}

test('Telegram endpoints require JSON POST and reject cross-site browser requests', async () => {
  const f = fixture();
  assert.equal((await f.send({ method: 'GET' })).status, 405);
  assert.equal((await f.send({ headers: { 'content-type': 'text/plain' } })).status, 405);
  assert.equal((await f.send({ headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal(f.count(), 0);
});

test('bearer credentials are read only from the header and all responses disable caching', async () => {
  const f = fixture();
  const result = await f.send({ headers: { authorization: 'Bearer SYNTHETIC_TOKEN' } });
  assert.equal(result.body.token, 'SYNTHETIC_TOKEN');
  assert.equal(result.headers['Cache-Control'], 'no-store');
  assert.equal((await f.send({ url: '/api/telegram/state?token=URL_SECRET' })).status, 404);
  assert.equal((await f.send({ payload: '{' })).status, 400);
});
