import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';

const root = dirname(fileURLToPath(new URL('../web-service.js', import.meta.url)));
const source = readFileSync(join(root, 'web-service.js'), 'utf8');
const require = createRequire(import.meta.url);

function proxyFixture(env = {}, upstream = () => []) {
  const requests = [];
  let handler;
  // Exercise the real HTTP handler without opening a port or loading local secrets.
  runInNewContext(source, {
    __dirname: root,
    URL,
    process: { env },
    console: { log() {} },
    require(name) {
      if (name === 'dotenv') return { config() {} };
      if (name === 'http') return { createServer(fn) { handler = fn; return { listen() {} }; } };
      return require(name);
    },
    async fetch(url, init) {
      const request = { url: new URL(url), ...init };
      requests.push(request);
      return { ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: async () => upstream(request) };
    }
  });
  async function send(payload) {
    const req = Object.assign(new EventEmitter(), { method: 'POST', url: '/api/mesh' });
    let response;
    const res = { setHeader() {}, end(raw) { response = JSON.parse(raw); } };
    const pending = handler(req, res);
    req.emit('data', JSON.stringify({ auth: { token: 'synthetic-token', profileId: '1', aid: '13' }, ...payload }));
    req.emit('end');
    await pending;
    return { status: res.statusCode, ...response };
  }
  return { send, requests };
}

test('teacher profile uses configured year despite stale auth and API_AID', async () => {
  const { send, requests } = proxyFixture({ API_ACADEMIC_YEAR_ID: '14', API_AID: '13' });
  const result = await send({ path: '/api/ej/core/teacher/v1/teacher_profiles/1' });
  assert.equal(result.status, 200);
  assert.equal(result.requestAcademicYearId, 14);
  assert.equal(requests[0].headers.aid, '14');
  assert.equal(requests[0].headers['Profile-Id'], '1');
  assert.equal(requests[0].headers.Authorization, 'Bearer synthetic-token');
});

test('explicit query year and aid match even when server default differs', async () => {
  const { send, requests } = proxyFixture({ API_ACADEMIC_YEAR_ID: '14' });
  await send({ path: '/api/ej/plan/teacher/v1/groups', query: { academic_year_id: 12 } });
  assert.equal(requests[0].url.searchParams.get('academic_year_id'), '12');
  assert.equal(requests[0].headers.aid, '12');
});

test('write request uses its academic year without changing its body', async () => {
  const { send, requests } = proxyFixture({ API_ACADEMIC_YEAR_ID: '14' });
  const body = { academic_year_id: 12, value: 5 };
  await send({ method: 'POST', path: '/api/ej/core/teacher/v1/final_marks', body });
  assert.equal(requests[0].headers.aid, '12');
  assert.deepEqual(JSON.parse(requests[0].body), body);
});

test('default aid follows the default academic year when no env is configured', async () => {
  const { send, requests } = proxyFixture();
  await send({ path: '/api/ej/core/teacher/v1/teacher_profiles/1' });
  assert.equal(requests[0].headers.aid, '14');
});

test('invalid explicit year does not send an upstream request', async () => {
  const { send, requests } = proxyFixture();
  const result = await send({ path: '/api/ej/plan/teacher/v1/groups', query: { academic_year_id: 'bad' } });
  assert.equal(result.status, 500);
  assert.match(result.error, /Invalid academic_year_id/);
  assert.equal(requests.length, 0);
});

test('profile assignments and group list are requested in the same year context', async () => {
  const { send, requests } = proxyFixture({ API_ACADEMIC_YEAR_ID: '14', API_AID: '13' }, ({ url, headers }) => {
    if (url.pathname.includes('/teacher_profiles/')) {
      return { assigned_group_ids: Array.from({ length: headers.aid === '14' ? 11 : 13 }, (_, i) => 100 + i) };
    }
    return headers.aid === url.searchParams.get('academic_year_id') ? [{ id: 100, academic_year_id: 14 }] : [];
  });
  const teacher = await send({ path: '/api/ej/core/teacher/v1/teacher_profiles/1' });
  assert.equal(teacher.data.assigned_group_ids.length, 11);
  const groups = await send({ path: '/api/ej/plan/teacher/v1/groups', query: {
    academic_year_id: 14, group_ids: teacher.data.assigned_group_ids.join(',')
  } });
  assert.equal(groups.data.length, 1);
  assert.ok(requests.every((r) => r.headers.aid === '14'));
});
