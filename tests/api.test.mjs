import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApiClient } from '../web/js/api.js';

const groupPath = '/api/ej/plan/teacher/v1/groups';

function client(t, responses) {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ ok: true, status: 200, data: responses.shift() }) };
  });
  const api = createApiClient({ getAuth: () => ({ token: 'secret-test-token', profileId: 987654 }) });
  return { ...api, requests };
}

test('pagination preserves all pages and stops on an empty array', async (t) => {
  const { fetchPaged, requests } = client(t, [[{ id: 1 }], [{ id: 2 }], []]);
  assert.deepEqual(await fetchPaged(groupPath, {}, 1, 5), [{ id: 1 }, { id: 2 }]);
  assert.deepEqual(requests.map((r) => r.query.page), [1, 2, 3]);
});

test('changed response format fails explicitly instead of returning no groups', async (t) => {
  const { fetchPaged } = client(t, [{ items: [{ id: 1 }] }]);
  await assert.rejects(fetchPaged(groupPath, {}, 10, 5), /Неожиданный формат ответа МЭШ/);
});

test('discovery logs contain structure and counts without credentials or personal values', async (t) => {
  const log = t.mock.method(console, 'info', () => {});
  const { meshApi } = client(t, [{
    id: 987654, first_name: 'Private Test Name', authentication_token: 'private-response-token',
    assigned_group_ids: [456789, 456790]
  }]);
  await meshApi('/api/ej/core/teacher/v1/teacher_profiles/987654');
  assert.equal(log.mock.calls.length, 1);
  const output = JSON.stringify(log.mock.calls[0].arguments);
  for (const secret of ['secret-test-token', 'private-response-token', 'Private Test Name', '987654', '456789']) {
    assert.ok(!output.includes(secret), `Diagnostic output contains ${secret}`);
  }
  const summary = JSON.parse(log.mock.calls[0].arguments[1]);
  assert.equal(summary.assignedGroupCount, 2);
  assert.equal(summary.path, '/api/ej/core/teacher/v1/teacher_profiles/:id');
});
