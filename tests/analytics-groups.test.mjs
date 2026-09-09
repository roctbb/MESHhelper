import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadAnalyticsData, buildSubjectRows } from '../web/js/engines/analytics.js';

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

function yearMismatchFixture({ explicit = false } = {}) {
  const { options, requests } = fixture([]);
  options.config.exportStartAt = '2026-09-01';
  options.config.exportStopAt = '2027-08-31';
  options.groupIds = explicit ? [10, 11] : [];
  options.meshApi = async (path) => {
    if (path.includes('/teacher_profiles/')) return { school_id: 1, assigned_group_ids: [10, 11] };
    assert.fail(`Should not inspect archived groups or periods: ${path}`);
  };
  options.fetchPaged = async (path, query) => {
    requests.push({ path, query });
    if (path.endsWith('/groups')) {
      if (query.academic_year_id !== 13) return [];
      assert.fail('Should not switch to year 13');
    }
    return [];
  };
  return { options, requests };
}

test('empty configured year stops after two list requests without loading archived data', async () => {
  const { options, requests } = yearMismatchFixture();
  await assert.rejects(loadAnalyticsData(options), /выбранный учебный год \(ID 14\)/);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((r) => r.path.endsWith('/groups') && r.query.academic_year_id === 14));
});

test('explicit groups missing from configured year fail without retrying another year', async () => {
  const { options, requests } = yearMismatchFixture({ explicit: true });
  await assert.rejects(loadAnalyticsData(options), /выбранный учебный год \(ID 14\)/);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].query.academic_year_id, 14);
});

test('groups explicitly belonging to another year never enter the report', async () => {
  const { options, requests } = fixture([
    { id: 10, class_unit_id: 100, academic_year_id: 14 },
    { id: 11, class_unit_id: 100, academic_year_id: 13 }
  ]);
  await loadAnalyticsData(options);
  assert.deepEqual(requests.filter((r) => r.path.endsWith('/marks')).map((r) => r.query.group_ids), ['10']);
});

test('managed class is used when teacher assignments are stale, without group detail requests', async () => {
  const { options, requests } = fixture([], { teacher: { managed_class_unit_ids: [100] } });
  const fetchPaged = options.fetchPaged;
  options.fetchPaged = async (path, query) => {
    const result = await fetchPaged(path, query);
    if (path.endsWith('/groups') && query.class_unit_ids === '100') {
      return [{ id: 20, class_unit_id: 100, academic_year_id: 14 }];
    }
    return result;
  };
  const meshApi = options.meshApi;
  options.meshApi = async (path) => {
    assert.ok(!path.includes('/groups/'));
    return meshApi(path);
  };
  const data = await loadAnalyticsData(options);
  assert.equal(data.academicYearId, 14);
  assert.deepEqual(data.selectedClassUnitIds, [100]);
  const students = requests.find((r) => r.path.endsWith('/student_profiles')).query;
  assert.equal(students.with_archived_groups, false);
  assert.equal(students.with_transferred, false);
  assert.equal(students.with_deleted, false);
  const marks = requests.find((r) => r.path.endsWith('/marks')).query;
  assert.equal(marks.lesson_date_from, '01.09.2026');
  assert.equal(marks.lesson_date_to, '31.08.2027');
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

test('all roster students are present even without marks, finals or attendances', async () => {
  const { options } = fixture([{ id: 10, class_unit_id: 100 }]);
  const fetchPaged = options.fetchPaged;
  options.fetchPaged = async (path, query) => {
    if (path.endsWith('/student_profiles')) return [
      { id: 501, short_name: 'Student A' },
      { id: 502, short_name: 'Student B' }
    ];
    return fetchPaged(path, query);
  };
  const data = await loadAnalyticsData(options);
  assert.deepEqual(data.students, ['Student A', 'Student B']);
  assert.deepEqual(data.byStudent['Student B'], []);
  assert.equal(data.studentCards[1].averageGrade, null);
});

test('shared group attendances cannot create unnamed students outside selected roster', async () => {
  const { options } = fixture([{ id: 10, class_unit_id: 100, subject_id: 5 }]);
  options.config.includeAttendances = true;
  const fetchPaged = options.fetchPaged;
  options.fetchPaged = async (path, query) => {
    if (path.endsWith('/student_profiles')) return [{ id: 501, short_name: 'Student A' }];
    if (path.endsWith('/attendances')) return [
      { student_profile_id: 501, schedule_lesson_id: 1, date: '2026-09-02' },
      { student_profile_id: 999, schedule_lesson_id: 1, date: '2026-09-02' }
    ];
    if (path.endsWith('/marks')) return [{ student_profile_id: 999, name: '5', date: '2026-09-02' }];
    return fetchPaged(path, query);
  };
  const data = await loadAnalyticsData(options);
  assert.deepEqual(data.students, ['Student A']);
  assert.equal(data.byStudent['Student A'].length, 1);
  assert.equal(data.byStudent['Student A'][0].markType, 'absence');
});

test('daily marks retain dates and individual values alongside calculated trimester averages', async () => {
  const { options } = fixture([{ id: 10, class_unit_id: 100, subject_id: 5, subject_name: 'Subject' }]);
  options.config.trimesterBoundaries = [{ label: '1 триместр', start: '2026-09-01', end: '2026-11-30' }];
  const fetchPaged = options.fetchPaged;
  options.fetchPaged = async (path, query) => {
    if (path.endsWith('/student_profiles')) return [{ id: 501, short_name: 'Student A' }];
    if (path.endsWith('/marks')) return [
      { student_profile_id: 501, name: '10', date: '03.09.2026', weight: 1, mark_type_id: 1 },
      { student_profile_id: 501, name: '8', date: '07.09.2026', weight: 2, mark_type_id: 1 }
    ];
    return fetchPaged(path, query);
  };
  const data = await loadAnalyticsData(options);
  const rows = data.byStudent['Student A'];
  assert.ok(rows.every((r) => r.markType === 'grade'));
  const subject = buildSubjectRows(rows, data.trimesterLabels, options.config.trimesterBoundaries)[0];
  const marks = subject.marksByTrimester[0].marks;
  assert.deepEqual(marks.map((m) => m.mark), ['10', '8']);
  assert.match(marks[0].tooltip, /03\.09\.2026/);
  assert.match(marks[1].tooltip, /07\.09\.2026/);
  assert.equal(subject.trimesterSource['1 триместр'], 'calculated');
  assert.equal(subject.trimesterFinalMarks['1 триместр'], null);
});
