import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildMarkingPreview, applyMarkingPreview, loadLessonDatesForMarking } from '../web/js/engines/marking.js';
import { MarkingScreen } from '../web/js/components/MarkingScreen.js';
import { toMoscowDate } from '../web/js/utils.js';

const ago = (hours) => new Date(Date.now() - hours * 3600000).toISOString();

function fixture(scheduleItems, students = [{ id: 40, short_name: 'Test Student' }]) {
  const requests = [];
  const options = {
    config: { academicYearId: 14, schoolId: 1 },
    auth: { profileId: 1 },
    groupId: 10,
    controlFormId: 20,
    namesText: 'Test Student',
    marksText: '8',
    comment: 'Test comment',
    async meshApi(path, request = {}) {
      requests.push({ path, ...request });
      assert.notEqual(request.method, 'POST', 'Preview must be read-only');
      if (path.endsWith('/groups/10')) return { id: 10, subject_id: 2, class_level_id: 8, class_unit_ids: [3] };
      if (path.endsWith('/teacher_profiles/1')) return { school_id: 1 };
      throw new Error(`Unexpected request: ${path}`);
    },
    async fetchPaged(path, query) {
      requests.push({ path, query });
      if (path.endsWith('/control_forms')) return [
        { id: 20, name: 'Practical work', grade_system: { id: 30 } },
        { id: 21, name: 'Oral answer', grade_system: { id: 31 } }
      ];
      if (path.endsWith('/student_profiles')) return students;
      if (path.endsWith('/schedule_items')) return scheduleItems;
      throw new Error(`Unexpected request: ${path}`);
    }
  };
  return { options, requests };
}

test('surname-only input uses structured surname or the MESH display name', async () => {
  const cases = [
    { id: 40, last_name: 'Семёнов', first_name: 'Иван' },
    { id: 40, short_name: 'Семёнов Иван' },
    { id: 40, user_name: 'Семёнов Иван Иванович' }
  ];
  for (const student of cases) {
    const { options } = fixture([{ id: 101, iso_date_time: ago(24) }], [student]);
    const preview = await buildMarkingPreview({ ...options, namesText: '  СЕМЕНОВ  ' });
    assert.equal(preview.rows[0].studentProfileId, 40);
    assert.equal(preview.rows[0].status, 'ready');
  }
});

test('ambiguous surnames require a name and cannot be posted', async () => {
  const { options } = fixture([{ id: 101, iso_date_time: ago(24) }], [
    { id: 40, short_name: 'Test Student' },
    { id: 41, short_name: 'Test Another' }
  ]);
  const preview = await buildMarkingPreview({ ...options, namesText: 'Test' });
  assert.equal(preview.rows[0].status, 'error');
  assert.match(preview.rows[0].reason, /Укажите имя/);
  assert.equal(preview.summary.ready, 0);
  await applyMarkingPreview({
    auth: options.auth, preview,
    meshApi() { assert.fail('Ambiguous surname must not be posted'); }
  });
  const namedPreview = await buildMarkingPreview(options);
  assert.equal(namedPreview.rows[0].studentProfileId, 40);
  assert.equal(namedPreview.rows[0].status, 'ready');
});

test('surname matching is exact, ignores duplicate profiles, and never uses a first name or synthetic ID', async () => {
  const { options } = fixture([{ id: 101, iso_date_time: ago(24) }], [
    { id: 40, short_name: 'Test Student' },
    { id: 40, short_name: 'Test Student' },
    { id: 41, first_name: 'Someone' },
    { id: 42 }
  ]);
  for (const name of ['Tes', 'Student', 'Someone', 'ID', 'Unknown']) {
    const preview = await buildMarkingPreview({ ...options, namesText: name });
    assert.equal(preview.rows[0].status, 'skip_not_in_group');
  }
  const preview = await buildMarkingPreview({ ...options, namesText: 'Test' });
  assert.equal(preview.rows[0].status, 'ready');
});

test('hyphenated surnames match and an empty grade stays skipped', async () => {
  const { options } = fixture([{ id: 101, iso_date_time: ago(24) }], [
    { id: 40, short_name: 'Test-Surname Student' }
  ]);
  const preview = await buildMarkingPreview({ ...options, namesText: 'Test-Surname', marksText: '\n' });
  assert.equal(preview.rows[0].studentProfileId, 40);
  assert.equal(preview.rows[0].status, 'skip_empty_grade');
});

test('preview selects the latest past lesson regardless of its topic or chosen control form', async () => {
  const { options, requests } = fixture([
    { id: 100, iso_date_time: ago(48), lesson_name: 'Практическая работа' },
    { id: 102, iso_date_time: ago(-48), lesson_name: 'Future lesson' },
    { id: 101, iso_date_time: ago(24), topic_name: 'Algorithms' },
    { id: 103, iso_date_time: 'invalid date' },
    { id: null, iso_date_time: ago(1) }
  ]);
  for (const controlFormId of [20, 21]) {
    const preview = await buildMarkingPreview({ ...options, controlFormId });
    assert.equal(preview.lesson.scheduleLessonId, 101);
    assert.equal(preview.lesson.lessonName, 'Algorithms');
    assert.equal(preview.controlForm.id, controlFormId);
    assert.equal(preview.summary.ready, 1);
  }
  const scheduleQuery = requests.find((r) => r.path.endsWith('/schedule_items')).query;
  assert.equal(scheduleQuery.group_ids, 10);
  assert.equal(scheduleQuery.academic_year_id, 14);
});

test('date choices contain only the ten most recent distinct past lesson dates', async () => {
  const items = Array.from({ length: 15 }, (_, i) => ({ id: i + 1, iso_date_time: `2020-09-${String(i + 1).padStart(2, '0')}T09:00:00Z` }));
  items.push({ id: 100, iso_date_time: '2020-09-15T10:00:00Z' });
  items.push({ id: 101, iso_date_time: ago(-48) });
  items.push({ id: 102, iso_date_time: 'invalid' });
  const { options } = fixture(items.reverse());
  const dates = await loadLessonDatesForMarking(options);
  assert.equal(dates.length, 10);
  assert.equal(dates[0], '2020-09-15');
  assert.equal(dates.at(-1), '2020-09-06');
  assert.equal(new Set(dates).size, 10);
  assert.deepEqual(await loadLessonDatesForMarking(fixture([]).options), []);
});

test('selected date uses the latest lesson on that Moscow calendar day only', async () => {
  const { options, requests } = fixture([
    { id: 101, iso_date_time: '2020-09-02T07:00:00Z' },
    { id: 102, iso_date_time: '2020-09-02T09:00:00Z' },
    { id: 103, iso_date_time: '2020-09-03T07:00:00Z' },
    { id: 104, iso_date_time: '2020-09-02T22:00:00Z' }
  ]);
  const preview = await buildMarkingPreview({ ...options, lessonDate: '2020-09-02' });
  assert.equal(preview.lesson.scheduleLessonId, 102);
  const query = requests.find((r) => r.path.endsWith('/schedule_items')).query;
  assert.equal(query.from, '2020-09-02');
  assert.equal(query.to, '2020-09-02');
  assert.equal(query.group_ids, options.groupId);
  assert.equal(query.academic_year_id, 14);
  const sent = [];
  await applyMarkingPreview({ auth: options.auth, preview, async meshApi(path, request) {
    sent.push(request.body);
    return { id: 1 };
  } });
  assert.equal(sent[0].schedule_lesson_id, 102);
});

test('date selection has no fallback when the selected day has no lessons', async () => {
  const { options } = fixture([{ id: 101, iso_date_time: '2020-09-01T09:00:00Z' }]);
  await assert.rejects(buildMarkingPreview({ ...options, lessonDate: '2020-09-02' }), /02\.09\.2020 нет прошедших уроков/);
});

test('invalid and future dates are rejected before requesting MESH', async () => {
  for (const lessonDate of ['2020-02-30', '02.09.2020', '2020-13-01', '9999-09-01']) {
    const { options, requests } = fixture([]);
    await assert.rejects(buildMarkingPreview({ ...options, lessonDate }), /дата урока|Дата урока/);
    assert.equal(requests.length, 0);
  }
  assert.equal(toMoscowDate('2020-09-01T22:30:00Z'), '2020-09-02');
});

test('preview rejects empty schedules and future-only lessons', async () => {
  for (const items of [[], [{ id: 1, iso_date_time: ago(-48) }]]) {
    const { options } = fixture(items);
    await assert.rejects(buildMarkingPreview(options), /Не найден прошедший урок для выбранной группы/);
  }
});

test('apply uses the preview lesson and selected control form in the mark payload', async () => {
  const { options } = fixture([{ id: 101, iso_date_time: ago(24), lesson_name: 'Algorithms' }]);
  const preview = await buildMarkingPreview({ ...options, controlFormId: 21 });
  const sent = [];
  const results = await applyMarkingPreview({
    auth: options.auth,
    preview,
    async meshApi(path, request) {
      sent.push({ path, ...request });
      return { id: 200 };
    }
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].path, '/api/ej/core/teacher/v1/marks');
  assert.equal(sent[0].method, 'POST');
  assert.equal(sent[0].body.schedule_lesson_id, 101);
  assert.equal(sent[0].body.control_form_id, 21);
  assert.deepEqual(sent[0].body.grade_origins, [{ grade_origin: '8', grade_system_id: 31 }]);
  assert.equal(results[0].status, 'created');
});

function screenFixture(previewCallback) {
  const refs = Object.fromEntries([
    'groupSelect', 'controlFormSelect', 'markingLessonDate', 'commentInput', 'namesInput', 'gradesInput',
    'previewBtn', 'applyBtn', 'markingStatus'
  ].map((key) => [key, {
    value: '', textContent: '', listeners: {},
    addEventListener(type, callback) { this.listeners[type] = callback; }
  }]));
  const state = { marking: {} };
  const screen = new MarkingScreen(refs, state, { preview: previewCallback });
  screen.renderPreviewRows = (rows) => { refs.renderedRows = rows; };
  screen.bind();
  return { refs, state, screen };
}

test('changing form, names, grades or comment invalidates a prepared preview', () => {
  const { refs, state } = screenFixture();
  for (const [key, event] of [
    ['controlFormSelect', 'change'], ['namesInput', 'input'],
    ['gradesInput', 'input'], ['commentInput', 'input'], ['markingLessonDate', 'change']
  ]) {
    state.marking.preview = { rows: [] };
    refs.applyBtn.disabled = false;
    refs.markingStatus.textContent = 'Готово: 3, пропуски: 19, ошибки: 0';
    refs.renderedRows = [{ status: 'ready' }];
    refs[key].listeners[event]();
    assert.equal(state.marking.preview, null);
    assert.equal(refs.applyBtn.disabled, true);
    assert.match(refs.markingStatus.textContent, /Предпросмотр устарел/);
    assert.deepEqual(refs.renderedRows, []);
  }
});

test('an in-flight preview cannot restore a stale form selection', async () => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const { refs, state } = screenFixture(() => pending);
  const click = refs.previewBtn.listeners.click();
  refs.controlFormSelect.listeners.change();
  resolve({ rows: [] });
  await click;
  assert.equal(state.marking.preview, null);
  assert.equal(refs.applyBtn.disabled, true);
});

test('date controls pass a chosen date and restore automatic selection', async () => {
  const requests = [];
  const preview = {
    lesson: { isoDateTime: '2020-09-02T09:00:00Z', lessonName: 'Test lesson' },
    controlForm: { name: 'Test form' }, rows: [], summary: { ready: 1 }
  };
  const { refs, state } = screenFixture(async (request) => { requests.push(request); return preview; });
  await refs.previewBtn.listeners.click();
  assert.equal(requests.at(-1).lessonDate, '');
  refs.markingLessonDate.value = '2020-09-02';
  refs.markingLessonDate.listeners.change();
  assert.equal(state.marking.preview, null);
  await refs.previewBtn.listeners.click();
  assert.equal(requests.at(-1).lessonDate, '2020-09-02');
  refs.markingLessonDate.value = '';
  refs.markingLessonDate.listeners.change();
  assert.equal(refs.applyBtn.disabled, true);
  await refs.previewBtn.listeners.click();
  assert.equal(requests.at(-1).lessonDate, '');
});

test('changing date while loading discards the stale preview', async () => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const { refs, state } = screenFixture(() => pending);
  const click = refs.previewBtn.listeners.click();
  refs.markingLessonDate.listeners.change();
  resolve({ rows: [] });
  await click;
  assert.equal(state.marking.preview, null);
  assert.equal(refs.applyBtn.disabled, true);
});

test('switching groups ignores an older schedule load that finishes later', async () => {
  const { refs, state, screen } = screenFixture();
  const resolvers = {};
  screen.callbacks.loadControlForms = (id) => new Promise((resolve) => { resolvers[id] = resolve; });
  screen.renderControlForms = () => {};
  refs.groupSelect.value = '10';
  const first = screen.loadControlFormsForSelectedGroup();
  assert.equal(refs.previewBtn.disabled, true);
  refs.groupSelect.value = '11';
  const second = screen.loadControlFormsForSelectedGroup();
  resolvers['11']({ controlForms: [{ id: 21 }], lessonDates: [] });
  await second;
  resolvers['10']({ controlForms: [{ id: 20 }], lessonDates: [] });
  await first;
  assert.equal(state.marking.controlFormsGroupId, '11');
  assert.equal(state.marking.controlForms[0].id, 21);
  assert.equal(refs.markingLessonDate.value, '');
  assert.equal(refs.previewBtn.disabled, false);
});

test('preview displays the selected lesson and form before enabling apply', async () => {
  const preview = {
    lesson: { isoDateTime: '2026-09-09T08:00:00Z', lessonName: 'Algorithms' },
    controlForm: { name: 'Practical work' }, rows: [], summary: { ready: 3, skipEmpty: 19, errors: 0 }
  };
  const { refs, state } = screenFixture(async () => preview);
  await refs.previewBtn.listeners.click();
  assert.equal(state.marking.preview, preview);
  assert.match(refs.markingStatus.textContent, /09\.09\.2026/);
  assert.match(refs.markingStatus.textContent, /11:00/);
  assert.match(refs.markingStatus.textContent, /Algorithms/);
  assert.match(refs.markingStatus.textContent, /Practical work/);
  assert.equal(refs.applyBtn.disabled, false);
  refs.commentInput.listeners.input();
  assert.equal(refs.applyBtn.disabled, true);
  await refs.previewBtn.listeners.click();
  assert.equal(refs.applyBtn.disabled, false);
  assert.match(refs.markingStatus.textContent, /Готово: 3/);
});
