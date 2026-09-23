import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { loadTelegramGroups, saveTelegramGroups } from '../web/js/telegram-storage.js';
const require = createRequire(import.meta.url);
const { createTelegramService, publicError } = require('../server/telegram-service.cjs');
const { TelegramStore } = require('../server/telegram-store.cjs');
const error = (errorMessage, extras = {}) => Object.assign(new Error(errorMessage), { errorMessage, ...extras });

function fixture(t, options = {}) {
  let clock = 1000000;
  const tasks = new Map(); let sequence = 0;
  const calls = [];
  const contacts = [{ id: '11', accessHash: '111', name: 'Анна', username: 'anna' }, { id: '12', accessHash: '222', name: 'Борис', username: '' }];
  const adapter = { connect: async () => {}, disconnect: async () => {}, save: () => 'SECRET_SESSION',
    sendCode: async () => ({ phoneCodeHash: 'SECRET_CODE_HASH', isCodeViaApp: true }),
    signIn: async () => ({ id: 1n, firstName: 'Учитель' }), password: async () => ({ id: 1n, firstName: 'Учитель' }),
    contacts: async () => contacts,
    send: async (recipient, message) => { calls.push({ ...recipient, message }); if (options.sendError) throw options.sendError; },
    logout: async () => {}, ...options.adapter };
  const store = options.store || { data: { sessions: {}, accounts: {} }, save() {} };
  const service = createTelegramService({ env: { TELEGRAM_API_ID: '123', TELEGRAM_API_HASH: 'a'.repeat(32),
    TELEGRAM_SEND_INTERVAL_MS: '30000', TELEGRAM_SEND_JITTER_MS: '0', ...options.env },
    store, adapterFactory: () => adapter, now: () => clock,
    randomInt: options.randomInt,
    schedule: (fn, delay) => { const id = ++sequence; tasks.set(id, { fn, at: clock + delay }); return id; },
    cancelSchedule: (id) => tasks.delete(id) });
  t.after(() => service.close());
  async function login(userId = 1) {
    const first = await service.handle('login', { phone: '+79991234567' });
    const old = adapter.signIn;
    if (userId !== 1) adapter.signIn = async () => ({ id: BigInt(userId), firstName: 'Другой' });
    try { return (await service.handle('code', { code: '12345' }, first.loginToken)).token; }
    finally { adapter.signIn = old; }
  }
  const payload = () => ({ requestId: randomUUID(), group: { name: 'Класс', contactIds: ['11', '12'] }, message: 'Встреча завтра', expected: true });
  return { service, store, adapter, contacts, calls, tasks, login, payload,
    advance: (ms) => { clock += ms; },
    tick: async () => {
      const entry = [...tasks].find(([, task]) => task.at <= clock);
      assert.ok(entry, 'expected a scheduled task'); tasks.delete(entry[0]); await entry[1].fn();
    } };
}

test('login returns an opaque token and no Telegram credentials; tokens isolate accounts', async (t) => {
  const f = fixture(t); const token = await f.login();
  assert.match(token, /^[a-f0-9]{64}$/);
  const state = await f.service.handle('state', {}, token);
  assert.equal(state.user.id, '1');
  assert.ok(!JSON.stringify(state).includes('SECRET'));
  assert.ok(!('groups' in state));
  await assert.rejects(f.service.handle('state', {}, '0'.repeat(64)), { status: 401 });
  const other = await f.login(2);
  await f.service.handle('send', f.payload(), token);
  assert.equal((await f.service.handle('state', {}, other)).jobs.length, 0);
});

test('2FA required preserves the pending login and checks password only after the code', async (t) => {
  const f = fixture(t, { adapter: { signIn: async () => { throw error('SESSION_PASSWORD_NEEDED'); } } });
  const { loginToken } = await f.service.handle('login', { phone: '+79991234567' });
  await assert.rejects(f.service.handle('password', { password: 'secret' }, loginToken), /Сначала/);
  assert.deepEqual(await f.service.handle('code', { code: '12345' }, loginToken), { needsPassword: true });
  assert.ok((await f.service.handle('password', { password: 'secret' }, loginToken)).token);
});

test('login sessions expire; authentication throttles repeated code requests', async (t) => {
  const f = fixture(t);
  const { loginToken } = await f.service.handle('login', { phone: '+79991234567' });
  f.advance(601000);
  await assert.rejects(f.service.handle('code', { code: '12345' }, loginToken), { status: 401 });
  await f.service.handle('login', { phone: '+79991234567' });
  await f.service.handle('login', { phone: '+79991234567' });
  await assert.rejects(f.service.handle('login', { phone: '+79991234567' }), { status: 429 });
});

test('only current Telegram contacts are accepted, duplicates collapse and access hashes stay server-side', async (t) => {
  const f = fixture(t); const token = await f.login();
  const contacts = await f.service.handle('contacts', {}, token);
  assert.ok(!JSON.stringify(contacts).includes('accessHash'));
  const payload = f.payload(); payload.group.contactIds = ['99'];
  await assert.rejects(f.service.handle('send', payload, token), /отсутствует/);
  payload.group.contactIds = ['11', '11'];
  const state = await f.service.handle('send', payload, token);
  assert.equal(state.jobs[0].recipients.length, 1);
  assert.ok(!JSON.stringify(state).includes('accessHash'));
  await f.tick(); assert.equal(f.calls[0].accessHash, '111');
});

test('idempotent submission and pacing prevent duplicate or concurrent broadcasts', async (t) => {
  const f = fixture(t); const token = await f.login(); const payload = f.payload();
  await f.service.handle('send', payload, token);
  await f.service.handle('send', payload, token);
  await assert.rejects(f.service.handle('send', f.payload(), token), { status: 409 });
  await f.tick(); assert.equal(f.calls.length, 1);
  assert.equal([...f.tasks.values()][0].at, 1030000);
  f.advance(30000); await f.tick();
  const state = await f.service.handle('state', {}, token);
  assert.equal(state.jobs.length, 1); assert.equal(state.jobs[0].status, 'completed');
  assert.notEqual(f.calls[0].randomId, f.calls[1].randomId);
  await f.service.handle('send', payload, token);
  assert.equal(f.calls.length, 2);
});

test('default pacing draws a fresh 0–5 second addition and persists the scheduled time', async (t) => {
  const samples = [0, 5000];
  const f = fixture(t, { env: { TELEGRAM_SEND_INTERVAL_MS: undefined, TELEGRAM_SEND_JITTER_MS: undefined },
    randomInt: (exclusiveMaximum) => { assert.equal(exclusiveMaximum, 5001); return samples.shift(); } });
  assert.deepEqual(await f.service.handle('config'), { configured: true, intervalMs: 5000, jitterMs: 5000 });
  const token = await f.login();
  await f.service.handle('send', f.payload(), token); await f.tick();
  assert.equal(f.store.data.accounts['1'].nextSendAt, 1005000);
  assert.equal([...f.tasks.values()][0].at, 1005000);
  f.advance(4999); assert.equal(f.calls.length, 1);
  assert.ok([...f.tasks.values()].every((task) => task.at > 1004999));
  f.advance(1); await f.tick();
  const state = await f.service.handle('state', {}, token);
  assert.equal(state.nextSendAt, 1015000);
  assert.equal(state.jitterMs, 5000);
  assert.equal(f.calls.length, 2); assert.equal(samples.length, 0);
});

test('FLOOD_WAIT pauses without retrying, persists cooldown, resumes only after the deadline', async (t) => {
  const f = fixture(t, { sendError: error('FLOOD_WAIT', { seconds: 90 }) });
  const token = await f.login(); const payload = f.payload();
  await f.service.handle('send', payload, token); await f.tick();
  const state = await f.service.handle('state', {}, token);
  assert.equal(state.jobs[0].status, 'paused'); assert.equal(state.nextSendAt, 1090000);
  assert.equal(f.tasks.size, 0);
  await assert.rejects(f.service.handle('resume', { id: payload.requestId }, token), { status: 429 });
  f.advance(90000);
  f.adapter.send = async (recipient) => f.calls.push({ ...recipient });
  await f.service.handle('resume', { id: payload.requestId }, token); await f.tick();
  assert.equal(f.calls[0].randomId, f.calls[1].randomId);
});

test('stopping a flood-limited broadcast does not clear the account-wide cooldown', async (t) => {
  const f = fixture(t, { sendError: error('FLOOD_WAIT_90') });
  const token = await f.login(); const payload = f.payload();
  await f.service.handle('send', payload, token); await f.tick();
  await f.service.handle('stop', { id: payload.requestId }, token);
  await assert.rejects(f.service.handle('send', f.payload(), token), { status: 429 });
});

test('spam restrictions halt the account across new logins and recipients', async (t) => {
  const f = fixture(t, { sendError: error('PEER_FLOOD') }); const token = await f.login(); const payload = f.payload();
  await f.service.handle('send', payload, token); await f.tick();
  assert.equal(f.calls.length, 1); assert.equal(f.tasks.size, 0);
  await f.service.handle('stop', { id: payload.requestId }, token);
  const otherToken = await f.login(); f.advance(30000);
  await assert.rejects(f.service.handle('send', f.payload(), otherToken), /ограничения/);
  await assert.rejects(f.service.handle('acknowledge-restriction', {}, otherToken), /Подтвердите/);
  await f.service.handle('acknowledge-restriction', { confirmed: true }, otherToken);
  assert.equal((await f.service.handle('state', {}, otherToken)).restricted, false);
  assert.equal(f.tasks.size, 0, 'acknowledgment alone must not start sending');
});

test('restrictions during contact loading also block future sending', async (t) => {
  const f = fixture(t); const token = await f.login();
  f.adapter.contacts = async () => { throw error('PEER_FLOOD'); };
  await assert.rejects(f.service.handle('contacts', {}, token));
  assert.equal((await f.service.handle('state', {}, token)).restricted, true);
  await assert.rejects(f.service.handle('send', f.payload(), token), /ограничения/);
});

test('two sessions for the same account cannot race to create concurrent broadcasts', async (t) => {
  const f = fixture(t); const token = await f.login(); const anotherToken = await f.login();
  let release;
  const contactsReady = new Promise((resolve) => { release = resolve; });
  f.adapter.contacts = async () => { await contactsReady; return f.contacts; };
  const one = f.service.handle('send', f.payload(), token);
  const two = f.service.handle('send', f.payload(), anotherToken);
  release();
  const results = await Promise.allSettled([one, two]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await f.service.handle('state', {}, token)).jobs.length, 1);
});

test('uncertain sends are not retried; resume only processes untouched recipients', async (t) => {
  const f = fixture(t, { sendError: new Error('socket closed') }); const token = await f.login(); const payload = f.payload();
  await f.service.handle('send', payload, token); await f.tick();
  assert.equal((await f.service.handle('state', {}, token)).jobs[0].recipients[0].status, 'unknown');
  f.adapter.send = async (recipient) => f.calls.push({ ...recipient });
  f.advance(30000); await f.service.handle('resume', { id: payload.requestId }, token); await f.tick();
  assert.deepEqual(f.calls.map((r) => r.id), ['11', '12']);
});

test('blocked recipients are skipped; remaining contacts still receive their message', async (t) => {
  const f = fixture(t, { sendError: error('USER_IS_BLOCKED') }); const token = await f.login();
  await f.service.handle('send', f.payload(), token); await f.tick();
  f.adapter.send = async (recipient) => f.calls.push({ ...recipient }); f.advance(30000); await f.tick();
  assert.deepEqual((await f.service.handle('state', {}, token)).jobs[0].recipients.map((r) => r.status), ['failed', 'sent']);
});

test('cancellation during an in-flight request never starts the next recipient', async (t) => {
  let release;
  const f = fixture(t, { adapter: { send: () => new Promise((resolve) => { release = resolve; }) } });
  const token = await f.login(); const payload = f.payload();
  await f.service.handle('send', payload, token);
  const running = f.tick(); await new Promise(setImmediate);
  await f.service.handle('stop', { id: payload.requestId }, token);
  f.advance(30000);
  await assert.rejects(f.service.handle('send', f.payload(), token), { status: 409 });
  release(); await running;
  const job = (await f.service.handle('state', {}, token)).jobs[0];
  assert.equal(job.status, 'cancelled'); assert.deepEqual(job.recipients.map((r) => r.status), ['sent', 'cancelled']);
  assert.equal(f.tasks.size, 0);
});

test('revoked sessions require login and stop the queue', async (t) => {
  const f = fixture(t, { sendError: error('SESSION_REVOKED') }); const token = await f.login();
  await f.service.handle('send', f.payload(), token); await f.tick();
  await assert.rejects(f.service.handle('state', {}, token), { status: 401 });
  assert.equal(f.tasks.size, 0);
});

test('message validation prevents unwanted empty, oversized or unacknowledged sends', async (t) => {
  const f = fixture(t); const token = await f.login();
  for (const change of [{ message: '' }, { message: 'x'.repeat(4097) }, { expected: false }, { group: { name: 'x', contactIds: [] } }]) {
    await assert.rejects(f.service.handle('send', { ...f.payload(), ...change }, token));
  }
  assert.equal(f.calls.length, 0); assert.equal(f.tasks.size, 0);
});

test('encrypted store hides sessions and messages; restart pauses jobs and never resends an uncertain recipient', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mesh-telegram-'));
  try {
    const store = new TelegramStore(directory);
    store.data.sessions.token = { secret: 'SENSITIVE_SESSION' };
    store.data.accounts.one = { jobs: [{ status: 'running', message: 'PRIVATE_MESSAGE', recipients: [{ status: 'sending' }, { status: 'pending' }] }] };
    store.save(); const raw = readFileSync(join(directory, 'state.enc')).toString();
    assert.ok(!raw.includes('SENSITIVE_SESSION')); assert.ok(!raw.includes('PRIVATE_MESSAGE'));
    const restored = new TelegramStore(directory);
    assert.equal(restored.data.sessions.token.secret, 'SENSITIVE_SESSION');
    assert.equal(restored.data.accounts.one.jobs[0].status, 'paused');
    assert.equal(restored.data.accounts.one.jobs[0].recipients[0].status, 'unknown');
    assert.throws(() => new TelegramStore(directory, Buffer.alloc(32, 1).toString('base64')));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('groups live in localStorage, remain isolated by account and tolerate malformed storage', () => {
  const entries = new Map(); const storage = { getItem: (key) => entries.get(key), setItem: (key, value) => entries.set(key, value) };
  const groups = [{ id: 'test', name: 'Моя группа', members: [{ id: '11', name: 'Анна' }] }];
  saveTelegramGroups(storage, '1', groups);
  assert.deepEqual(loadTelegramGroups(storage, '1'), groups);
  assert.deepEqual(loadTelegramGroups(storage, '2'), []);
  entries.set('telegram_groups_v1_1', '{'); assert.deepEqual(loadTelegramGroups(storage, '1'), []);
});

test('public errors never expose session strings, passwords or raw network messages', () => {
  const result = publicError(new Error('socket SECRET_SESSION private phone +79991234567'));
  assert.ok(!result.error.includes('SECRET')); assert.ok(!result.error.includes('+7999'));
  assert.equal(publicError(error('FLOOD_WAIT', { seconds: 42 })).retryAfter, 42);
});
