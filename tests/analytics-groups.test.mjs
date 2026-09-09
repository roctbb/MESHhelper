import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadAnalyticsData } from '../web/js/engines/analytics.js';

function fixture(groups, { teacher = {}, details = {}, explicit = false } = {}) {
  const requests = [];
  const options = {
    config: { academicYearId: 14, trimesterBoundaries: [] },
    auth: { profileId: 1 },
    savedClassFilter: '__all__',
    statusCb() {},
    groupIds: explicit ? groups.map((g) => g.id) : [],
    async meshApi(path) {
      if (path.includes('/teacher_profiles/')) return { school_id: 1, assigned_group_ids: [10], ...teacher };
      if (path.includes('/groups/')) return details;
      throw new Error(`Unexpected request: ${path}`);
    },
    async fetchPaged(path, query) {
      requests.push({ path, query });
      if (path.endsWith('/groups')) return groups;
      return [];
    }
  };
  return { options, requests };
}

test('analytics keeps unknown student counts but skips confirmed empty and meta groups', async () => {
  const groups = [undefined, null, '', 0, '0', 25, '12'].map((student_count, i) => ({
    id: 10 + i, class_unit_id: 100, subject_id: 5, student_count
  }));
  groups.push({ id: 99, class_unit_id: 100, student_count: 30, is_metagroup: true });
  const { options, requests } = fixture(groups);
  await loadAnalyticsData(options);
  const markGroups = requests.filter((r) => r.path.endsWith('/marks')).map((r) => r.query.group_ids);
  assert.deepEqual(markGroups.sort(), ['10', '11', '12', '15', '16']);
});

test('null class references trigger detail lookup instead of querying class zero', async () => {
  const { options, requests } = fixture([{ id: 10, class_unit_id: null }], {
    details: { id: 10, class_unit: { id: 100, name: 'Class A' } }
  });
  const data = await loadAnalyticsData(options);
  assert.deepEqual(data.selectedClassUnitIds, [100]);
  assert.equal(requests.find((r) => r.query.class_unit_ids)?.query.class_unit_ids, '100');
});

test('invalid class IDs in profile and groups cannot create a class zero', async () => {
  const { options } = fixture([{ id: 10, class_unit_id: null, class_unit_ids: [null, '', 0, -1] }], {
    teacher: { class_unit_ids: [null, '', 0, -1] }
  });
  await assert.rejects(loadAnalyticsData(options), /Не удалось определить классы/);
});

test('explicit group details retain class and subject metadata from the list', async () => {
  const { options, requests } = fixture([{ id: 10, class_unit_id: 100, subject_id: 5 }], {
    explicit: true, details: { id: 10 }
  });
  const data = await loadAnalyticsData(options);
  assert.deepEqual(data.selectedClassUnitIds, [100]);
  assert.equal(requests.find((r) => r.path.endsWith('/marks')).query.subject_id, 5);
});

test('empty API response is reported separately from excluded groups', async () => {
  const { options } = fixture([], { teacher: { class_unit_ids: [100] } });
  await assert.rejects(loadAnalyticsData(options), /получено 0, метагрупп 0, пустых 0/);
});

test('known-empty groups produce counts in the error', async () => {
  const { options } = fixture([{ id: 10, class_unit_id: 100, student_count: 0 }]);
  await assert.rejects(loadAnalyticsData(options), /получено 1, метагрупп 0, пустых 1/);
});
