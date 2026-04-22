import { norm, normalizeName, parallelMap } from '../utils.js';

function mapGroup(g) {
  return {
    id: Number(g.id),
    name: norm(g.name),
    subjectName: norm(g.subject_name),
    subjectId: Number(g.subject_id),
    classLevelId: Number(g.class_level_id),
    classUnitIds: Array.isArray(g.class_unit_ids) ? g.class_unit_ids.map((x) => Number(x)).filter(Number.isFinite) : [],
    studentCount: Number(g.student_count || 0)
  };
}

function toEducationLevelId(classLevelId) {
  const n = Number(classLevelId);
  if (!Number.isFinite(n)) return 2;
  if (n <= 4) return 1;
  if (n <= 9) return 2;
  return 3;
}

function splitLines(raw) {
  const lines = String(raw || '').replace(/\r/g, '').split('\n');
  if (lines.length && !lines.at(-1).trim()) lines.pop();
  return lines;
}

function parseGradeLine(v) {
  const s = norm(v);
  if (!s) return null;
  if (!/^\d+$/.test(s)) throw new Error(`Недопустимая отметка "${v}"`);
  const n = Number(s);
  if (n < 1 || n > 10) throw new Error(`Недопустимая отметка "${v}"`);
  return n;
}

function pickPracticalLesson(items) {
  const now = Date.now();
  return [...(items || [])]
    .filter((it) => {
      const ts = Date.parse(String(it.iso_date_time || ''));
      if (!Number.isFinite(ts) || ts > now) return false;
      const title = `${norm(it.lesson_name)} ${norm(it.topic_name)}`.toLowerCase();
      return /практич/.test(title);
    })
    .sort((a, b) => Date.parse(String(b.iso_date_time || '')) - Date.parse(String(a.iso_date_time || '')))[0] || null;
}

function pickControlForm(forms) {
  const list = Array.isArray(forms) ? forms : [];
  const practical = list.filter((f) => /практич/.test(`${norm(f.name)} ${norm(f.short_name)}`.toLowerCase()));
  if (!practical.length) return null;

  const parseNmaxFromText = (v) => {
    const s = norm(v).toLowerCase();
    if (!s) return null;
    const m = s.match(/(\d+)\s*[- ]?\s*бал/);
    if (m && Number.isFinite(Number(m[1]))) return Number(m[1]);
    if (/\b10\b/.test(s)) return 10;
    return null;
  };

  const parseNmax = (f) => {
    const candidates = [
      f?.grade_system?.nmax,
      f?.grade_system?.max,
      f?.grade_system?.max_value,
      f?.grade_system?.value_max,
      f?.grade_system_nmax,
      f?.nmax
    ];
    for (const c of candidates) {
      const n = Number(c);
      if (Number.isFinite(n)) return n;
    }
    return parseNmaxFromText(f?.grade_system?.name) ?? parseNmaxFromText(f?.grade_system_name);
  };

  const withScore = practical.map((f) => {
    const nmax = parseNmax(f);
    const score = Number.isFinite(nmax) ? (nmax === 10 ? 100 : nmax >= 10 ? 80 : 0) : 20;
    return { f, nmax, score };
  });

  withScore.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return Number(b.f?.id || 0) - Number(a.f?.id || 0);
  });

  // Предпочитаем явную 10-балльную форму, но если система не вернула nmax, берём лучший практический вариант.
  const best = withScore.find((x) => x.score >= 80) || withScore.find((x) => x.score >= 20) || null;
  return best?.f || null;
}

function debugControlForms(label, forms) {
  const list = Array.isArray(forms) ? forms : [];
  const rows = list.map((f) => ({
    id: Number(f?.id) || null,
    name: norm(f?.name),
    shortName: norm(f?.short_name),
    deleted: Boolean(f?.deleted_at || f?.is_deleted),
    gradeSystemId: Number(f?.grade_system?.id || f?.grade_system_id || f?.grade_system?.grade_system_id) || null,
    gradeSystemName: norm(f?.grade_system?.name || f?.grade_system_name),
    nmax: Number(
      f?.grade_system?.nmax
      || f?.grade_system?.max
      || f?.grade_system?.max_value
      || f?.grade_system?.value_max
      || f?.grade_system_nmax
      || f?.nmax
    ) || null
  }));
  console.group(`[MESHhelper] ${label}: ${rows.length} forms`);
  console.table(rows);
  console.log('Raw control forms:', list);
  console.groupEnd();
}

function findThemeIntegrationId(scheduleItem) {
  const didactic = Array.isArray(scheduleItem?.didactic_units) ? scheduleItem.didactic_units : [];
  const fromDidactic = didactic.map((x) => Number(x.theme_integration_id)).find(Number.isFinite);
  if (Number.isFinite(fromDidactic)) return String(fromDidactic);
  const direct = Number(scheduleItem?.theme_frame_integration_id);
  return Number.isFinite(direct) ? String(direct) : null;
}

export async function loadGroupsForMarking({ meshApi, fetchPaged, config, auth, statusCb }) {
  statusCb('Получаем профиль учителя...');
  const teacher = await meshApi(`/api/ej/core/teacher/v1/teacher_profiles/${auth.profileId}`, {
    query: { with_assigned_groups: true, with_replacement_groups: true }
  });

  const schoolId = Number(config.schoolId) || Number(teacher?.school_id) || 0;
  const academicYearId = Number(config.academicYearId) || 13;

  const rawIds = Array.isArray(teacher?.assigned_group_ids) && teacher.assigned_group_ids.length
    ? teacher.assigned_group_ids
    : teacher?.group_ids;
  const groupIds = (Array.isArray(rawIds) ? rawIds : []).map((x) => Number(x)).filter(Number.isFinite);
  if (!groupIds.length) throw new Error('Не нашли assigned_group_ids у профиля учителя');

  const chunks = [];
  for (let i = 0; i < groupIds.length; i += 100) chunks.push(groupIds.slice(i, i + 100));

  statusCb(`Получаем группы (${groupIds.length})...`);
  const pages = await parallelMap(chunks, 4, async (chunk) => {
    return fetchPaged('/api/ej/plan/teacher/v1/groups', {
      academic_year_id: academicYearId,
      school_id: schoolId,
      group_ids: chunk.join(','),
      with_periods_schedule_id: true
    }, config.groupsPerPage || 300, 10);
  });

  const uniq = new Map();
  pages.flat().forEach((g) => {
    const id = Number(g?.id);
    if (Number.isFinite(id)) uniq.set(id, g);
  });

  const groups = [...uniq.values()]
    .filter((g) => !g.is_metagroup)
    .filter((g) => Number(g.student_count || 0) > 0)
    .map(mapGroup);

  return { groups };
}

export async function buildMarkingPreview({ meshApi, fetchPaged, config, groupId, namesText, marksText, comment }) {
  const gid = Number(groupId);
  if (!Number.isFinite(gid)) throw new Error('Выберите группу');

  const names = splitLines(namesText);
  const grades = splitLines(marksText);
  if (names.length !== grades.length) throw new Error(`Количество строк не совпадает: ФИО=${names.length}, отметки=${grades.length}`);
  if (!names.length) throw new Error('Введите хотя бы одну строку');

  const parsed = names.map((name, idx) => {
    const inputName = norm(name);
    if (!inputName) throw new Error(`Пустая строка ФИО: ${idx + 1}`);
    const parts = inputName.split(' ');
    if (parts.length < 2) throw new Error(`Неверный формат ФИО в строке ${idx + 1}`);
    return {
      line: idx + 1,
      inputName,
      inputNameNorm: normalizeName(inputName),
      grade: parseGradeLine(grades[idx])
    };
  });

  const group = await meshApi(`/api/ej/plan/teacher/v1/groups/${gid}`);
  const classUnitIds = Array.isArray(group.class_unit_ids) ? group.class_unit_ids.map((x) => Number(x)).filter(Number.isFinite) : [];
  const academicYearId = Number(config.academicYearId) || 13;
  const schoolId = Number(config.schoolId) || Number(group.school_id) || 0;

  const students = await fetchPaged('/api/ej/core/teacher/v1/student_profiles', {
    academic_year_id: academicYearId,
    class_unit_ids: classUnitIds.join(','),
    group_ids: gid,
    with_groups: true,
    with_home_based_periods: true,
    with_deleted: false,
    with_final_marks: false,
    with_archived_groups: false,
    with_transferred: false
  }, 200, 20);

  const studentIndex = new Map();
  students.forEach((p) => {
    const id = Number(p.id);
    if (!Number.isFinite(id)) return;
    const fio = [p.last_name, p.first_name, p.middle_name].map(norm).filter(Boolean).join(' ');
    const userName = fio || norm(p.short_name || p.user_name || `ID ${id}`);
    const keys = [
      normalizeName(userName),
      normalizeName(norm(p.short_name)),
      normalizeName([norm(p.last_name), norm(p.first_name)].filter(Boolean).join(' '))
    ].filter(Boolean);
    keys.forEach((k) => {
      if (!studentIndex.has(k)) studentIndex.set(k, []);
      studentIndex.get(k).push({ id, userName });
    });
  });

  const from = `${new Date().getFullYear() - 1}-09-01`;
  const to = new Date().toISOString().slice(0, 10);
  const scheduleItems = await fetchPaged('/api/ej/plan/teacher/v1/schedule_items', {
    academic_year_id: academicYearId,
    group_ids: gid,
    from,
    to,
    with_group_class_subject_info: true,
    with_course_calendar_info: true,
    with_lesson_info: true,
    with_rooms_info: true,
    with_availability_info: true
  }, 300, 20);

  const lesson = pickPracticalLesson(scheduleItems);
  if (!lesson) throw new Error('Не найден прошедший урок с типом "Практическая работа"');

  const controlForms = await fetchPaged('/api/ej/core/teacher/v1/control_forms', {
    academic_year_id: academicYearId,
    school_id: schoolId,
    subject_id: Number(group.subject_id),
    with_grade_system: true,
    with_deleted: false,
    education_level_id: toEducationLevelId(group.class_level_id)
  }, 1000, 2);
  debugControlForms('control_forms primary', controlForms);
  let controlForm = pickControlForm(controlForms);
  if (!controlForm) {
    // Fallback: на части окружений education_level_id режет список форм контроля.
    const fallbackControlForms = await fetchPaged('/api/ej/core/teacher/v1/control_forms', {
      academic_year_id: academicYearId,
      school_id: schoolId,
      subject_id: Number(group.subject_id),
      with_grade_system: true,
      with_deleted: false
    }, 1000, 2);
    debugControlForms('control_forms fallback', fallbackControlForms);
    controlForm = pickControlForm(fallbackControlForms);
  }
  if (!controlForm) throw new Error('Не найдена форма контроля "Практическая работа" (10-балльная)');

  const controlFormGradeSystemId = Number(
    controlForm?.grade_system?.id
    || controlForm?.grade_system_id
    || controlForm?.grade_system?.grade_system_id
  );
  if (!Number.isFinite(controlFormGradeSystemId)) {
    throw new Error('Не удалось определить grade_system_id у формы контроля "Практическая работа"');
  }

  const rows = parsed.map((r) => {
    const matches = [...new Map((studentIndex.get(r.inputNameNorm) || []).map((x) => [x.id, x])).values()];
    if (!matches.length) {
      return { line: r.line, inputName: r.inputName, grade: r.grade, status: 'skip_not_in_group', reason: 'Ученик не найден в группе' };
    }
    if (matches.length > 1) {
      return { line: r.line, inputName: r.inputName, grade: r.grade, status: 'error', reason: 'Найдено несколько учеников с таким именем' };
    }
    if (r.grade === null) {
      return {
        line: r.line,
        inputName: r.inputName,
        studentProfileId: matches[0].id,
        studentName: matches[0].userName,
        grade: null,
        status: 'skip_empty_grade',
        reason: 'Пустая отметка'
      };
    }
    return {
      line: r.line,
      inputName: r.inputName,
      studentProfileId: matches[0].id,
      studentName: matches[0].userName,
      grade: r.grade,
      status: 'ready',
      reason: ''
    };
  });

  return {
    group: { id: gid, name: norm(group.name), subjectName: norm(group.subject_name) },
    lesson: {
      scheduleLessonId: Number(lesson.id),
      isoDateTime: lesson.iso_date_time,
      lessonName: norm(lesson.lesson_name),
      themeFrameIntegrationId: findThemeIntegrationId(lesson)
    },
    controlForm: {
      id: Number(controlForm.id),
      name: norm(controlForm.name),
      gradeSystemId: controlFormGradeSystemId
    },
    comment: String(comment || ''),
    rows,
    summary: {
      ready: rows.filter((x) => x.status === 'ready').length,
      skipNotInGroup: rows.filter((x) => x.status === 'skip_not_in_group').length,
      skipEmpty: rows.filter((x) => x.status === 'skip_empty_grade').length,
      errors: rows.filter((x) => x.status === 'error').length
    }
  };
}

export async function applyMarkingPreview({ meshApi, auth, preview }) {
  const teacherId = Number(auth?.profileId);
  if (!Number.isFinite(teacherId)) throw new Error('Некорректный profile_id');

  const out = [];
  for (const row of preview.rows || []) {
    if (row.status !== 'ready') {
      out.push({ ...row });
      continue;
    }

    const payload = {
      comment: String(preview.comment || ''),
      is_exam: false,
      is_criterion: false,
      is_point: false,
      point_date: '',
      schedule_lesson_id: Number(preview.lesson.scheduleLessonId),
      student_profile_id: Number(row.studentProfileId),
      teacher_id: teacherId,
      control_form_id: Number(preview.controlForm.id),
      weight: 1,
      theme_frame_integration_id: preview.lesson.themeFrameIntegrationId || null,
      course_lesson_topic_id: null,
      grade_origins: [{ grade_origin: String(row.grade), grade_system_id: Number(preview.controlForm.gradeSystemId) }],
      grade_system_type: false,
      mark_type_id: 1
    };

    try {
      const created = await meshApi('/api/ej/core/teacher/v1/marks', { method: 'POST', body: payload });
      out.push({ ...row, status: 'created', reason: '', markId: Number(created?.id) || null });
    } catch (err) {
      out.push({ ...row, status: 'error', reason: err.message || 'Ошибка API' });
    }
  }

  return out;
}
