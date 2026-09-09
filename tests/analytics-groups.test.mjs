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

test('analytics requests marks regardless of student count and skips standalone meta groups', async () => {
  const groups = [undefined, null, '', 0, '0', 25, '12'].map((student_count, i) => ({
    id: 10 + i, class_unit_id: 100, subject_id: 5, student_count
  }));
  groups.push({ id: 99, class_unit_id: 100, student_count: 30, is_metagroup: true });
  const { options, requests } = fixture(groups);
  await loadAnalyticsData(options);
  const markGroups = requests.filter((r) => r.path.endsWith('/marks')).map((r) => r.query.group_ids);
  assert.deepEqual(markGroups.sort(), ['10', '11', '12', '13', '14', '15', '16']);
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
  await assert.rejects(loadAnalyticsData(options), /получено 0, метагрупп 0/);
});

test('zero membership count does not prevent requesting group marks', async () => {
  const { options, requests } = fixture([{ id: 10, class_unit_id: 100, student_count: 0 }]);
  await loadAnalyticsData(options);
  assert.equal(requests.filter((r) => r.path.endsWith('/marks')).length, 1);
});

function yearMismatchFixture({ explicit = false, years = [13, 13], withPeriods = true } = {}) {
  const { options, requests } = fixture([]);
  options.config.exportStartAt = '2026-09-01';
  options.config.exportStopAt = '2027-08-31';
  options.groupIds = explicit ? [10, 11] : [];
  const group = (id, year) => ({
    id, academic_year_id: year, class_unit_id: 100, subject_id: id,
    student_count: 20, attestation_periods_schedule_id: 200
  });
  options.meshApi = async (path) => {
    if (path.includes('/teacher_profiles/')) return { school_id: 1, assigned_group_ids: [10, 11] };
    if (path.includes('/groups/')) {
      const id = Number(path.split('/').at(-1));
      return group(id, years[id - 10]);
    }
    if (path.includes('/attestation_periods_schedules/')) return { periods: withPeriods ? [
      { id: 1, name: 'Period 1', begin_date: '2025-09-01', end_date: '2025-11-30' },
      { id: 2, name: 'Period 2', begin_date: '2025-12-01', end_date: '2026-05-31' }
    ] : [] };
    throw new Error(`Unexpected request: ${path}`);
  };
  options.fetchPaged = async (path, query) => {
    requests.push({ path, query });
    if (path.endsWith('/groups')) {
      if (query.academic_year_id !== 13) return [];
      return (query.class_unit_ids ? [10, 11, 12] : [10, 11]).map((id) => group(id, 13));
    }
    return [];
  };
  return { options, requests };
}

test('empty configured year falls back to group year and loads all class subjects for its dates', async () => {
  const { options, requests } = yearMismatchFixture();
  const data = await loadAnalyticsData(options);
  assert.equal(data.academicYearId, 13);
  assert.deepEqual(requests.filter((r) => r.path.endsWith('/groups')).map((r) => r.query.academic_year_id), [14, 13]);
  assert.equal(requests.find((r) => r.path.endsWith('/student_profiles')).query.academic_year_id, 13);
  const marks = requests.filter((r) => r.path.endsWith('/marks'));
  assert.equal(marks.length, 3);
  assert.ok(marks.every((r) => r.query.lesson_date_from === '01.09.2025' && r.query.lesson_date_to === '31.05.2026'));
});

test('explicit groups also retry their observed academic year', async () => {
  const { options, requests } = yearMismatchFixture({ explicit: true });
  const data = await loadAnalyticsData(options);
  assert.equal(data.academicYearId, 13);
  assert.deepEqual(requests.filter((r) => r.path.endsWith('/groups')).map((r) => r.query.academic_year_id), [14, 13]);
  assert.equal(requests.filter((r) => r.path.endsWith('/marks')).length, 2);
});

test('conflicting observed years do not select an arbitrary year', async () => {
  const { options, requests } = yearMismatchFixture({ years: [12, 13] });
  await assert.rejects(loadAnalyticsData(options), /разным учебным годам/);
  assert.equal(requests.filter((r) => r.path.endsWith('/groups')).length, 1);
});

test('missing year in one detail does not switch based on partial evidence', async () => {
  const { options, requests } = yearMismatchFixture({ years: [13, null] });
  await assert.rejects(loadAnalyticsData(options), /Учебный год ID: 14/);
  assert.ok(requests.filter((r) => r.path.endsWith('/groups')).every((r) => r.query.academic_year_id === 14));
});

test('year fallback cannot silently use configured dates if schedules are unavailable', async () => {
  const { options, requests } = yearMismatchFixture({ withPeriods: false });
  await assert.rejects(loadAnalyticsData(options), /не удалось получить его периоды/);
  assert.equal(requests.filter((r) => r.path.endsWith('/marks')).length, 0);
});

test('49 archived groups with zero counts load historical marks through 35 subject groups', async () => {
  const { options, requests } = yearMismatchFixture();
  const fetchPaged = options.fetchPaged;
  options.fetchPaged = async (path, query) => {
    const result = await fetchPaged(path, query);
    if (path.endsWith('/groups') && query.class_unit_ids && query.academic_year_id === 13) {
      const groups = Array.from({ length: 35 }, (_, i) => ({
        ...result[0], id: 10 + i, subject_id: 10 + i, student_count: 0,
        attestation_periods_schedule_id: i === 34 ? null : 200
      }));
      const metaGroups = Array.from({ length: 14 }, (_, i) => ({
        id: 1000 + i, subject_id: 10 + i, subgroup_ids: [10 + i], is_metagroup: true,
        student_count: 0
      }));
      return [...groups, ...metaGroups];
    }
    if (path.endsWith('/student_profiles')) {
      assert.equal(query.academic_year_id, 13);
      assert.equal(query.class_unit_ids, '100');
      assert.equal(query.with_archived_groups, true);
      assert.equal(query.with_transferred, true);
      assert.equal(query.with_deleted, true);
      return [{ id: 501, short_name: 'Historical student' }];
    }
    if (path.endsWith('/marks') && query.group_ids === '10,1000') {
      return [{ student_profile_id: 501, name: '5', date: '2025-10-01' }];
    }
    return result;
  };
  const data = await loadAnalyticsData(options);
  assert.equal(requests.filter((r) => r.path.endsWith('/marks')).length, 35);
  assert.deepEqual(data.students, ['Historical student']);
  assert.equal(data.byStudent['Historical student'][0].numericMark, 5);
  assert.equal(data.byStudent['Historical student'][0].date, '01.10.2025');
});

test('explicit zero-count groups also retain historical marks', async () => {
  const { options, requests } = fixture([{ id: 10, class_unit_id: 100, student_count: 0 }], { explicit: true });
  const fetchPaged = options.fetchPaged;
  options.fetchPaged = async (path, query) => {
    const result = await fetchPaged(path, query);
    if (path.endsWith('/student_profiles')) return [{ id: 501, short_name: 'Historical student' }];
    if (path.endsWith('/marks')) return [{ student_profile_id: 501, name: '4', date: '2026-09-02' }];
    return result;
  };
  const data = await loadAnalyticsData(options);
  assert.equal(requests.find((r) => r.path.endsWith('/student_profiles')).query.group_ids, '10');
  assert.equal(data.byStudent['Historical student'][0].numericMark, 4);
});
