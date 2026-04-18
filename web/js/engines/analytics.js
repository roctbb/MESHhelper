import {
  norm,
  parseRuDate,
  toRuDate,
  monthShortRu,
  parallelMap
} from '../utils.js';

const STRONG_TREND_DIFF = 2;

export function parseMarkValue(raw, values) {
  const s = norm(raw);
  if (!s) return null;
  if (/^(см|нв)\.?$/i.test(s)) return null;
  if (/^н$/i.test(s)) return { mark: 'н', markType: 'absence', numericMark: null };

  const m = s.match(/^(\d+(?:[.,]\d+)?)([+-])?$/);
  if (m) {
    let n = Number(m[1].replace(',', '.'));
    if (m[2] === '+') n += 0.25;
    if (m[2] === '-') n -= 0.25;
    return { mark: s, markType: 'grade', numericMark: Number.isFinite(n) ? n : null };
  }

  const ten = Number(values?.[0]?.grade?.ten);
  if (Number.isFinite(ten)) return { mark: s, markType: 'grade', numericMark: ten };
  return { mark: s, markType: 'other', numericMark: null };
}

function parseFinalMarkValue(finalMark) {
  if (Boolean(finalMark?.academic_debt)) return 2;
  const asNum = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  };
  const manual = asNum(finalMark?.manual_value);
  const value = asNum(finalMark?.value);
  const origin = asNum(finalMark?.origin);
  const grade = asNum(finalMark?.grade);
  const gradeValue = asNum(finalMark?.grade_value);
  const picked = manual ?? value ?? origin ?? grade ?? gradeValue;
  if (!Number.isFinite(picked) || picked <= 0 || picked > 100) return null;
  return picked;
}

function pickFinalPeriodId(finalMark) {
  const candidates = [
    finalMark?.attestation_period_id,
    finalMark?.period_id,
    finalMark?.attestation_period?.id,
    finalMark?.period?.id
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function pickFinalPeriodLabel(finalMark) {
  const candidates = [
    finalMark?.attestation_period_name,
    finalMark?.period_name,
    finalMark?.attestation_period?.name,
    finalMark?.period?.name,
    finalMark?.period?.title,
    finalMark?.name
  ];
  for (const c of candidates) {
    const s = norm(c);
    if (s) return s;
  }
  return '';
}

function detectTrimesterByDate(dateObj, trimesterBoundaries) {
  for (const t of trimesterBoundaries || []) {
    const s = new Date(`${t.start}T00:00:00`);
    const e = new Date(`${t.end}T23:59:59`);
    if (dateObj >= s && dateObj <= e) return t.label;
  }
  return 'Без триместра';
}

export function canonicalTrimesterLabel(label, trimesterBoundaries) {
  const raw = norm(label).toLowerCase();
  const labels = (trimesterBoundaries || []).map((x) => x.label);
  if (/(^|\s)1(\s|$)|\b1\s*тр|\b1\s*т|\bi\b/.test(raw)) return labels[0] || '1 триместр';
  if (/(^|\s)2(\s|$)|\b2\s*тр|\b2\s*т|\bii\b/.test(raw)) return labels[1] || '2 триместр';
  if (/(^|\s)3(\s|$)|\b3\s*тр|\b3\s*т|\biii\b/.test(raw)) return labels[2] || '3 триместр';
  return norm(label);
}

export function pickCurrentTrimester(trimesterBoundaries) {
  const now = new Date();
  for (const t of trimesterBoundaries || []) {
    const s = new Date(`${t.start}T00:00:00`);
    const e = new Date(`${t.end}T23:59:59`);
    if (now >= s && now <= e) return t.label;
  }
  return (trimesterBoundaries || []).at(-1)?.label || '3 триместр';
}

function mapGroup(g) {
  return {
    id: Number(g.id),
    name: norm(g.name),
    subjectName: norm(g.subject_name),
    subjectId: Number(g.subject_id),
    classLevelId: Number(g.class_level_id),
    classUnitId: Number(g.class_unit_id) || null,
    classUnitName: norm(g.class_unit_name),
    classUnitIds: Array.isArray(g.class_unit_ids) ? g.class_unit_ids.map((x) => Number(x)).filter(Number.isFinite) : [],
    attestationScheduleId: Number(g.attestation_periods_schedule_id) || null,
    studentCount: Number(g.student_count || 0)
  };
}

function extractTeacherClassUnitIds(teacher) {
  const ids = [];
  const candidates = [
    teacher?.class_unit_ids,
    teacher?.mentor_class_unit_ids,
    teacher?.curator_class_unit_ids,
    teacher?.assigned_class_unit_ids
  ];
  candidates.forEach((arr) => {
    (Array.isArray(arr) ? arr : []).forEach((x) => {
      const n = Number(x);
      if (Number.isFinite(n)) ids.push(n);
    });
  });
  return [...new Set(ids)];
}

async function fetchGroupsByIds(fetchPaged, groupIds, schoolId, academicYearId, groupsPerPage, statusCb) {
  if (!groupIds.length) return [];
  const chunks = [];
  const chunkSize = 100;
  for (let i = 0; i < groupIds.length; i += chunkSize) chunks.push(groupIds.slice(i, i + chunkSize));

  statusCb(`Получаем группы учителя (${groupIds.length})...`);
  const pages = await parallelMap(chunks, 4, async (chunk) => {
    return fetchPaged('/api/ej/plan/teacher/v1/groups', {
      academic_year_id: academicYearId,
      school_id: schoolId,
      group_ids: chunk.join(','),
      with_periods_schedule_id: true
    }, groupsPerPage || 300, 10);
  });

  const uniq = new Map();
  pages.flat().forEach((g) => {
    const id = Number(g?.id);
    if (Number.isFinite(id)) uniq.set(id, g);
  });
  return [...uniq.values()];
}

async function loadGroupsForAnalytics({ meshApi, fetchPaged, config, auth, savedClassFilter, statusCb }) {
  statusCb('Получаем профиль учителя...');
  const teacher = await meshApi(`/api/ej/core/teacher/v1/teacher_profiles/${auth.profileId}`, {
    query: {
      with_assigned_groups: true,
      with_replacement_groups: true
    }
  });

  const schoolId = Number(config.schoolId) || Number(teacher?.school_id) || 0;
  const academicYearId = Number(config.academicYearId) || 13;
  const envClassUnitIds = Array.isArray(config.analyticsClassUnitIds)
    ? config.analyticsClassUnitIds.map((x) => Number(x)).filter(Number.isFinite)
    : [];

  const rawGroupIds = Array.isArray(teacher?.assigned_group_ids) && teacher.assigned_group_ids.length
    ? teacher.assigned_group_ids
    : teacher?.group_ids;
  const groupIds = (Array.isArray(rawGroupIds) ? rawGroupIds : []).map((x) => Number(x)).filter(Number.isFinite);
  const teacherGroupsRaw = await fetchGroupsByIds(fetchPaged, groupIds, schoolId, academicYearId, config.groupsPerPage, statusCb);

  const classOptionMap = new Map();
  teacherGroupsRaw.forEach((g) => {
    const cid = Number(g.class_unit_id);
    if (Number.isFinite(cid)) classOptionMap.set(cid, norm(g.class_unit_name) || `Класс ${cid}`);
    const cids = Array.isArray(g.class_unit_ids) ? g.class_unit_ids.map((x) => Number(x)).filter(Number.isFinite) : [];
    cids.forEach((id) => {
      if (!classOptionMap.has(id)) classOptionMap.set(id, `Класс ${id}`);
    });
  });

  extractTeacherClassUnitIds(teacher).forEach((id) => {
    if (!classOptionMap.has(id)) classOptionMap.set(id, `Класс ${id}`);
  });
  envClassUnitIds.forEach((id) => {
    if (!classOptionMap.has(id)) classOptionMap.set(id, `Класс ${id}`);
  });

  if (!classOptionMap.size && !envClassUnitIds.length) {
    statusCb('Классы не найдены в профиле, пробуем общий список доступных групп...');
    const fallbackGroups = await fetchPaged('/api/ej/plan/teacher/v1/groups', {
      academic_year_id: academicYearId,
      school_id: schoolId,
      with_periods_schedule_id: true
    }, config.groupsPerPage || 300, 20);
    fallbackGroups.forEach((g) => {
      const cid = Number(g.class_unit_id);
      if (Number.isFinite(cid)) classOptionMap.set(cid, norm(g.class_unit_name) || `Класс ${cid}`);
      const cids = Array.isArray(g.class_unit_ids) ? g.class_unit_ids.map((x) => Number(x)).filter(Number.isFinite) : [];
      cids.forEach((id) => {
        if (!classOptionMap.has(id)) classOptionMap.set(id, `Класс ${id}`);
      });
    });
  }

  const classOptions = [...classOptionMap.entries()]
    .map(([id, name]) => ({ id: Number(id), name }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  if (!classOptions.length) throw new Error('Не удалось определить классы для аналитики');

  const selectedClassUnitId = savedClassFilter === '__all__' || classOptions.some((x) => String(x.id) === savedClassFilter)
    ? savedClassFilter
    : '__all__';
  const selectedByUi = selectedClassUnitId === '__all__' ? classOptions.map((x) => x.id) : [Number(selectedClassUnitId)];
  const selectedClassUnitIds = envClassUnitIds.length ? envClassUnitIds : selectedByUi;
  const sourceLabel = envClassUnitIds.length ? 'env(API_CLASS_UNIT_IDS)' : (selectedClassUnitId === '__all__' ? 'все классы' : `класс ${selectedClassUnitId}`);

  statusCb(`Получаем группы классного руководителя (${sourceLabel})...`);
  const groupsRaw = await fetchPaged('/api/ej/plan/teacher/v1/groups', {
    academic_year_id: academicYearId,
    school_id: schoolId,
    class_unit_ids: selectedClassUnitIds.join(','),
    with_periods_schedule_id: true
  }, config.groupsPerPage || 300, 20);

  const uniq = new Map();
  groupsRaw.forEach((g) => {
    const id = Number(g?.id);
    if (Number.isFinite(id)) uniq.set(id, g);
  });

  const groups = [...uniq.values()]
    .filter((g) => !g.is_metagroup)
    .filter((g) => Number(g.student_count || 0) > 0)
    .map(mapGroup);

  return {
    groups,
    schoolId,
    academicYearId,
    classOptions,
    selectedClassUnitId: envClassUnitIds.length ? '__all__' : selectedClassUnitId,
    selectedClassUnitIds
  };
}

export function buildSubjectRows(rows, trimesterLabels, trimesterBoundaries) {
  const bySubject = new Map();
  let seq = 0;

  rows.forEach((row) => {
    const subject = norm(row.subject) || 'Неизвестный предмет';
    if (!bySubject.has(subject)) {
      bySubject.set(subject, {
        subject,
        marksCount: 0,
        pointsCount: 0,
        academicDebt: false,
        absencesCount: 0,
        gradesCount: 0,
        gradesSum: 0,
        gradesWeight: 0,
        marksByTrimester: new Map(),
        trimesterStats: new Map(),
        explicitTrimesterMarks: new Map(),
        explicitYearMark: null
      });
    }
    const item = bySubject.get(subject);

    const mark = norm(row.mark);
    const isAbsence = /^н$/i.test(mark);
    const isAcademicDebt = Boolean(row.academicDebt);
    if (isAcademicDebt) item.academicDebt = true;
    const isFinalYear = row.markType === 'final_year' && Number.isFinite(Number(row.numericMark));
    const isFinalTrim = row.markType === 'final_trimester' && Number.isFinite(Number(row.numericMark));
    const finalLabel = canonicalTrimesterLabel(row.trimesterLabel || row.period, trimesterBoundaries);

    if (isFinalYear) {
      item.explicitYearMark = Number(row.numericMark);
      return;
    }

    if (isFinalTrim && finalLabel) {
      item.explicitTrimesterMarks.set(finalLabel, Number(row.numericMark));
      return;
    }

    const dateRaw = row.date || row.period;
    const d = parseRuDate(dateRaw);
    const dateObj = d ? new Date(d.y, d.m - 1, d.d, 12, 0, 0) : null;
    const trimester = dateObj ? detectTrimesterByDate(dateObj, trimesterBoundaries) : 'Без триместра';
    const weight = Number.isFinite(Number(row.weight)) && Number(row.weight) > 0 ? Number(row.weight) : 1;
    const isPoint = Boolean(row.isPoint);
    const comment = norm(row.comment);

    if (isAbsence) {
      item.absencesCount += 1;
      return;
    }

    item.marksCount += 1;
    if (isPoint) item.pointsCount += 1;
    if (!item.marksByTrimester.has(trimester)) item.marksByTrimester.set(trimester, []);
    item.marksByTrimester.get(trimester).push({
      mark,
      isPoint,
      weight,
      tooltip: `${dateObj ? `${String(d.d).padStart(2, '0')}.${String(d.m).padStart(2, '0')}.${d.y}` : norm(row.period) || 'Без даты'}${isPoint ? ', точка (можно исправить)' : ''}${comment ? `, комментарий: ${comment}` : ''}`,
      ts: dateObj ? dateObj.getTime() : Number.MAX_SAFE_INTEGER,
      seq: seq++
    });

    const num = Number(row.numericMark);
    if (Number.isFinite(num)) {
      item.gradesCount += 1;
      item.gradesSum += num * weight;
      item.gradesWeight += weight;

      if (!item.trimesterStats.has(trimester)) item.trimesterStats.set(trimester, { sum: 0, weight: 0 });
      const st = item.trimesterStats.get(trimester);
      st.sum += num * weight;
      st.weight += weight;
    }
  });

  return [...bySubject.values()].map((s) => {
    if (s.marksByTrimester.has('Без триместра')) {
      const knownKeys = [...s.marksByTrimester.keys()].filter((k) => k !== 'Без триместра');
      if (knownKeys.length === 1) {
        const unknown = s.marksByTrimester.get('Без триместра') || [];
        const target = knownKeys[0];
        s.marksByTrimester.set(target, [...(s.marksByTrimester.get(target) || []), ...unknown]);
        s.marksByTrimester.delete('Без триместра');
      }
    }

    const trimesterAverages = {};
    const trimesterRounded = {};
    const trimesterSource = {};

    trimesterLabels.forEach((label) => {
      const explicit = s.explicitTrimesterMarks.get(label);
      const st = s.trimesterStats.get(label);

      if (Number.isFinite(explicit)) {
        trimesterAverages[label] = Number(explicit);
        trimesterSource[label] = 'final';
      } else if (st && st.weight > 0) {
        trimesterAverages[label] = Number((st.sum / st.weight).toFixed(2));
        trimesterSource[label] = 'calculated';
      } else {
        trimesterAverages[label] = null;
        trimesterSource[label] = null;
      }
      trimesterRounded[label] = Number.isFinite(trimesterAverages[label]) ? Math.round(trimesterAverages[label]) : null;
    });

    const rounded = Object.values(trimesterRounded).filter(Number.isFinite);
    const annualCalculated = rounded.length ? Number((rounded.reduce((a, b) => a + b, 0) / rounded.length).toFixed(2)) : null;
    const annual = Number.isFinite(s.explicitYearMark) ? Number(s.explicitYearMark) : annualCalculated;
    const yearSource = Number.isFinite(s.explicitYearMark) ? 'final' : (Number.isFinite(annualCalculated) ? 'calculated' : null);

    const weightedMarks = [];
    [...s.marksByTrimester.values()].flat().forEach((m) => {
      const count = Number.isFinite(Number(m.weight)) ? Math.max(1, Math.round(Number(m.weight))) : 1;
      for (let i = 0; i < count; i += 1) weightedMarks.push(m);
    });
    weightedMarks.sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq));

    let trend = null;
    let trendDiff = null;
    let trendStrength = 'none';
    const W = 10;
    if (weightedMarks.length >= W) {
      const recent = weightedMarks.slice(-W);
      const half = Math.floor(W / 2);
      const first = recent.slice(0, half);
      const second = recent.slice(-half);
      const avg = (arr) => arr.reduce((sum, m) => sum + Number.parseFloat(m.mark), 0) / arr.length;
      const diff = avg(second) - avg(first);
      if (diff > 1) { trend = 'up'; trendDiff = diff; }
      if (diff < -1) { trend = 'down'; trendDiff = diff; }
      if (Math.abs(diff) >= STRONG_TREND_DIFF) trendStrength = 'strong';
    }

    const marksByTrimester = [...s.marksByTrimester.entries()].map(([trimester, marks]) => ({
      trimester,
      marks: [...marks].sort((a, b) => (a.ts - b.ts) || (a.seq - b.seq)).map((m) => ({
        mark: m.mark,
        isPoint: Boolean(m.isPoint),
        weight: m.weight,
        tooltip: Number(m.weight) > 1 ? `${m.tooltip}, коэф. ${m.weight}` : m.tooltip
      }))
    }));

    marksByTrimester.sort((a, b) => {
      const ai = trimesterLabels.indexOf(a.trimester);
      const bi = trimesterLabels.indexOf(b.trimester);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });

    return {
      subject: s.subject,
      marksCount: s.marksCount,
      pointsCount: s.pointsCount,
      hasPoints: s.pointsCount > 0,
      academicDebt: Boolean(s.academicDebt),
      gradesCount: s.gradesCount,
      absencesCount: s.absencesCount,
      averageGrade: annual,
      averageGradeRaw: s.gradesWeight > 0 ? Number((s.gradesSum / s.gradesWeight).toFixed(2)) : null,
      yearSource,
      trend,
      trendDiff: trendDiff !== null ? Number(trendDiff.toFixed(2)) : null,
      trendStrength,
      trimesterAverages,
      trimesterRounded,
      trimesterSource,
      marksByTrimester
    };
  }).sort((a, b) => a.subject.localeCompare(b.subject, 'ru'));
}

export function buildStudentCard(name, rows, currentTrimester, trimesterLabels, trimesterBoundaries) {
  const subjectRows = buildSubjectRows(rows, trimesterLabels, trimesterBoundaries);
  // Student-level averages should be computed across all marks with weight coefficients.
  // Final trimester/year marks are excluded from this "marks average" metric.
  let allSum = 0;
  let allWeight = 0;
  let curSum = 0;
  let curWeight = 0;
  for (const row of rows) {
    if (row.markType !== 'grade') continue;
    const n = Number(row.numericMark);
    if (!Number.isFinite(n)) continue;
    const wRaw = Number(row.weight);
    const w = Number.isFinite(wRaw) && wRaw > 0 ? wRaw : 1;
    allSum += n * w;
    allWeight += w;

    const d = parseRuDate(row.date || row.period);
    if (!d) continue;
    const dateObj = new Date(d.y, d.m - 1, d.d, 12, 0, 0);
    const tri = detectTrimesterByDate(dateObj, trimesterBoundaries);
    if (tri === currentTrimester) {
      curSum += n * w;
      curWeight += w;
    }
  }
  const avg = allWeight > 0 ? Number((allSum / allWeight).toFixed(2)) : null;
  const currentAvg = curWeight > 0 ? Number((curSum / curWeight).toFixed(2)) : null;

  const currentRiskSubjects = subjectRows
    .filter((x) => Number.isFinite(x.trimesterAverages[currentTrimester]) && Math.round(x.trimesterAverages[currentTrimester]) < 7)
    .map((x) => x.subject);

  const yearRiskSubjects = subjectRows
    .filter((x) => Number.isFinite(x.averageGrade) && Math.round(x.averageGrade) < 7)
    .map((x) => x.subject);

  const trends = subjectRows.map((x) => x.trend).filter(Boolean);
  const ups = trends.filter((t) => t === 'up').length;
  const downs = trends.filter((t) => t === 'down').length;
  const strongUpSubjects = subjectRows
    .filter((x) => x.trend === 'up' && x.trendStrength === 'strong')
    .map((x) => x.subject);
  const strongDownSubjects = subjectRows
    .filter((x) => x.trend === 'down' && x.trendStrength === 'strong')
    .map((x) => x.subject);
  const pointSubjects = subjectRows
    .filter((x) => Number(x.pointsCount || 0) > 0)
    .map((x) => x.subject);
  const pointsCount = subjectRows.reduce((sum, x) => sum + Number(x.pointsCount || 0), 0);
  const academicDebtSubjects = subjectRows
    .filter((x) => Boolean(x.academicDebt))
    .map((x) => x.subject);
  const excellentAllSubjects = subjectRows.length > 0 && subjectRows.every((x) => (
    Number.isFinite(x.averageGrade) && Math.round(x.averageGrade) >= 9
  ));

  return {
    name,
    averageGrade: avg,
    currentTrimesterAverage: currentAvg,
    averageTrend: ups > downs ? 'up' : downs > ups ? 'down' : null,
    strongTrendUp: strongUpSubjects.length > 0,
    strongTrendDown: strongDownSubjects.length > 0,
    strongTrendUpSubjects: strongUpSubjects,
    strongTrendDownSubjects: strongDownSubjects,
    hasPoints: pointsCount > 0,
    pointsCount,
    pointSubjects,
    hasAcademicDebt: academicDebtSubjects.length > 0,
    academicDebtSubjects,
    excellentAllSubjects,
    warningCurrentTrimester: currentRiskSubjects.length > 0,
    warningYear: yearRiskSubjects.length > 0,
    currentTrimesterRiskSubjects: currentRiskSubjects,
    yearRiskSubjects
  };
}

export async function loadAnalyticsData({ meshApi, fetchPaged, config, auth, savedClassFilter, statusCb }) {
  const {
    groups,
    academicYearId,
    classOptions,
    selectedClassUnitId,
    selectedClassUnitIds
  } = await loadGroupsForAnalytics({ meshApi, fetchPaged, config, auth, savedClassFilter, statusCb });
  if (!groups.length) throw new Error('Нет доступных групп для аналитики');

  statusCb(`Получаем список учеников (${selectedClassUnitIds.length} классов)...`);
  const profiles = await fetchPaged('/api/ej/core/teacher/v1/student_profiles', {
    academic_year_id: academicYearId,
    class_unit_ids: selectedClassUnitIds.join(','),
    with_groups: true,
    with_home_based_periods: true,
    with_deleted: false,
    with_final_marks: true,
    with_archived_groups: false,
    with_transferred: false
  }, 300, 25);

  const studentNameById = new Map();
  for (const p of profiles) {
    const id = Number(p.id);
    if (!Number.isFinite(id)) continue;
    const fio = [p.last_name, p.first_name, p.middle_name].map(norm).filter(Boolean).join(' ');
    studentNameById.set(id, fio || norm(p.short_name || p.user_name || `ID ${id}`));
  }

  const scheduleMap = new Map();
  const uniqueScheduleIds = [...new Set(groups.map((g) => g.attestationScheduleId).filter(Number.isFinite))];
  statusCb('Получаем расписание аттестационных периодов...');
  await parallelMap(uniqueScheduleIds, 4, async (sid) => {
    try {
      const schedule = await meshApi(`/api/ej/core/teacher/v1/attestation_periods_schedules/${sid}`);
      const periods = Array.isArray(schedule?.periods) ? schedule.periods : [];
      periods.forEach((p) => {
        const id = Number(p.id);
        if (Number.isFinite(id)) scheduleMap.set(id, norm(p.name));
      });
    } catch (_) {
    }
  });

  const from = toRuDate(config.exportStartAt || '2025-09-01');
  const to = toRuDate(config.exportStopAt || '2026-08-31');
  const rows = [];

  statusCb(`Получаем отметки по группам (${groups.length})...`);
  await parallelMap(groups, 4, async (group, idx) => {
    const marks = await fetchPaged('/api/ej/core/teacher/v1/marks', {
      group_ids: group.id,
      subject_id: group.subjectId,
      class_level_id: group.classLevelId,
      created_at_from: from,
      created_at_to: to,
      with_non_numeric_entries: true
    }, config.marksPerPage || 300, 220);

    marks.forEach((item) => {
      const studentProfileId = Number(item.student_profile_id);
      const student = studentNameById.get(studentProfileId) || `ID ${studentProfileId}`;
      const parsed = parseMarkValue(item.name || item.values?.[0]?.grade?.origin, item.values);
      if (!parsed) return;
      const ruDate = toRuDate(item.date);
      const pDate = parseRuDate(ruDate);
      const pointRawDate = toRuDate(item.point_date);
      const pointParsed = parseRuDate(pointRawDate);
      const isPointFlag = Boolean(item.is_point) || Number(item.mark_type_id) === 2 || Boolean(item.point_date);
      let isPointActive = false;
      if (isPointFlag) {
        if (pointParsed) {
          const pointDeadline = new Date(pointParsed.y, pointParsed.m - 1, pointParsed.d, 23, 59, 59, 999);
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          isPointActive = pointDeadline >= today;
        } else {
          isPointActive = true;
        }
      }

      rows.push({
        student,
        subject: group.subjectName,
        month: pDate ? monthShortRu(pDate.m) : '',
        day: pDate ? String(pDate.d) : '',
        period: ruDate || '',
        mark: parsed.mark,
        markType: parsed.markType,
        numericMark: Number.isFinite(parsed.numericMark) ? parsed.numericMark : null,
        studentProfileId,
        groupId: group.id,
        subjectId: group.subjectId,
        scheduleLessonId: Number(item.schedule_lesson_id) || null,
        isPoint: isPointActive,
        academicDebt: false,
        comment: norm(item.comment),
        weight: Number.isFinite(Number(item.weight)) && Number(item.weight) > 0 ? Number(item.weight) : 1,
        date: ruDate,
        sourceFile: 'api'
      });
    });

    if (config.includeAttendances) {
      const attendances = await fetchPaged('/api/ej/core/teacher/v1/attendances', {
        group_ids: group.id,
        academic_year_id: academicYearId,
        class_level_id: group.classLevelId,
        start_at: from,
        stop_at: to
      }, config.attendancesPerPage || 1000, 40);

      const seen = new Set(
        rows
          .filter((r) => r.markType === 'absence' && r.groupId === group.id)
          .map((r) => `${r.studentProfileId}|${r.scheduleLessonId}|${r.groupId}`)
      );

      attendances.forEach((a) => {
        const studentProfileId = Number(a.student_profile_id);
        if (!Number.isFinite(studentProfileId)) return;
        const scheduleLessonId = Number(a.schedule_lesson_id) || null;
        const key = `${studentProfileId}|${scheduleLessonId}|${group.id}`;
        if (seen.has(key)) return;
        seen.add(key);

        const student = studentNameById.get(studentProfileId) || `ID ${studentProfileId}`;
        const ruDate = toRuDate(a.date);
        const pDate = parseRuDate(ruDate);

        rows.push({
          student,
          subject: group.subjectName,
          month: pDate ? monthShortRu(pDate.m) : '',
          day: pDate ? String(pDate.d) : '',
          period: ruDate || '',
          mark: 'н',
          markType: 'absence',
          numericMark: null,
          studentProfileId,
          groupId: group.id,
          subjectId: group.subjectId,
          scheduleLessonId,
          isPoint: false,
          academicDebt: false,
          comment: '',
          weight: 1,
          date: ruDate,
          sourceFile: 'api'
        });
      });
    }

    statusCb(`Получаем отметки... ${idx + 1}/${groups.length}`);
  });

  statusCb('Добавляем выставленные триместровые...');
  const groupBySubject = new Map();
  groups.forEach((g) => {
    if (!groupBySubject.has(g.subjectId)) groupBySubject.set(g.subjectId, g);
  });

  for (const p of profiles) {
    const studentProfileId = Number(p.id);
    if (!Number.isFinite(studentProfileId)) continue;
    const student = studentNameById.get(studentProfileId) || `ID ${studentProfileId}`;
    const finals = Array.isArray(p.final_marks) ? p.final_marks : [];

    for (const fm of finals) {
      if (Boolean(fm.no_mark)) continue;

      const subjectId = Number(fm.subject_id);
      const periodId = pickFinalPeriodId(fm);
      const numeric = parseFinalMarkValue(fm);
      if (!Number.isFinite(subjectId) || !Number.isFinite(numeric)) continue;

      const subjectGroup = groupBySubject.get(subjectId);
      const isYear = Boolean(fm.is_year_mark || fm.year_mark);
      const rawPeriodLabel = Number.isFinite(periodId) ? (scheduleMap.get(periodId) || '') : pickFinalPeriodLabel(fm);
      const trimesterLabel = isYear
        ? 'Год'
        : canonicalTrimesterLabel(rawPeriodLabel, config.trimesterBoundaries || []);
      if (!isYear && !trimesterLabel) continue;

      rows.push({
        student,
        subject: subjectGroup ? subjectGroup.subjectName : `subject_${subjectId}`,
        month: '',
        day: '',
        period: trimesterLabel,
        mark: String(Math.round(numeric)),
        markType: isYear ? 'final_year' : 'final_trimester',
        numericMark: Number(numeric),
        studentProfileId,
        groupId: subjectGroup ? subjectGroup.id : null,
        subjectId,
        scheduleLessonId: null,
        isPoint: false,
        academicDebt: Boolean(fm.academic_debt),
        comment: '',
        weight: 1,
        date: '',
        trimesterLabel,
        sourceFile: 'api'
      });
    }
  }

  const byStudent = {};
  rows.forEach((r) => {
    if (!byStudent[r.student]) byStudent[r.student] = [];
    byStudent[r.student].push(r);
  });

  const students = Object.keys(byStudent).sort((a, b) => a.localeCompare(b, 'ru'));
  const currentTrimester = pickCurrentTrimester(config.trimesterBoundaries || []);
  const trimesterLabels = (config.trimesterBoundaries || []).map((x) => x.label);
  const studentCards = students.map((name) => buildStudentCard(name, byStudent[name] || [], currentTrimester, trimesterLabels, config.trimesterBoundaries || []));

  return {
    students,
    byStudent,
    studentCards,
    classOptions,
    selectedClassUnitId,
    selectedClassUnitIds,
    currentTrimester,
    trimesterLabels
  };
}
