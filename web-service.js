const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { chromium } = require('playwright');
const {
  fetchPlanGroups,
  fetchPlanGroupsByGroupIds,
  fetchTeacherProfile,
  fetchGroupById,
  fetchGroupStudentProfiles,
  fetchScheduleItemsByGroup,
  fetchControlForms,
  createMark
} = require('./tools/mesh-api');
require('dotenv').config();

const ROOT = __dirname;
const OUTPUT_DIR = path.join(ROOT, 'output');
const WEB_DIR = path.join(ROOT, 'web');
const PORT = Number(process.env.WEB_PORT || '8787');
const VISIBILITY_FILE = path.join(OUTPUT_DIR, 'student-visibility.json');
const MARKING_GROUPS_FILE = path.join(OUTPUT_DIR, 'marking-groups-latest.json');
const TREND_WINDOW = Math.max(2, Number(process.env.TREND_WINDOW) || 5);
const MARKING_HEADLESS = String(
  process.env.MARKING_HEADLESS ?? process.env.HEADLESS ?? 'false'
).toLowerCase() === 'true';
const MARKING_PROFILE_DIR = path.resolve(process.env.BROWSER_PROFILE_DIR || path.join(OUTPUT_DIR, 'browser-profile'));
const MARKING_TIMEOUT_MS = Math.max(5000, Number(process.env.MARKING_TIMEOUT_MS || 30000));
const MARKING_PREOPEN_ON_START = String(process.env.MARKING_PREOPEN_ON_START ?? 'true').toLowerCase() === 'true';
const START_SYNC_ON_START = String(process.env.START_SYNC_ON_START ?? 'true').toLowerCase() === 'true';
const START_SYNC_STRICT = String(process.env.START_SYNC_STRICT ?? 'false').toLowerCase() === 'true';

function norm(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

function ensureOutputDir() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

function loadHiddenStudents() {
  try {
    if (!fs.existsSync(VISIBILITY_FILE)) return new Set();
    const raw = JSON.parse(fs.readFileSync(VISIBILITY_FILE, 'utf8'));
    const items = Array.isArray(raw.hiddenStudents) ? raw.hiddenStudents : [];
    return new Set(items.map((x) => norm(x)).filter(Boolean));
  } catch (_) {
    return new Set();
  }
}

function saveHiddenStudents(hiddenSet) {
  ensureOutputDir();
  const payload = {
    updatedAt: new Date().toISOString(),
    hiddenStudents: [...hiddenSet].sort((a, b) => a.localeCompare(b, 'ru'))
  };
  fs.writeFileSync(VISIBILITY_FILE, JSON.stringify(payload, null, 2));
}

function loadCachedMarkingGroups() {
  try {
    if (!fs.existsSync(MARKING_GROUPS_FILE)) return [];
    const raw = JSON.parse(fs.readFileSync(MARKING_GROUPS_FILE, 'utf8'));
    const groups = Array.isArray(raw?.groups) ? raw.groups : [];
    return groups
      .map((g) => ({
        id: Number(g.id),
        name: norm(g.name),
        subjectName: norm(g.subjectName),
        classUnitName: norm(g.classUnitName),
        studentCount: Number.isFinite(Number(g.studentCount)) ? Number(g.studentCount) : null,
        subjectId: Number.isFinite(Number(g.subjectId)) ? Number(g.subjectId) : null,
        classLevelId: Number.isFinite(Number(g.classLevelId)) ? Number(g.classLevelId) : null,
        canMark: true
      }))
      .filter((g) => Number.isFinite(g.id));
  } catch (_) {
    return [];
  }
}

function saveCachedMarkingGroups(groups) {
  try {
    ensureOutputDir();
    fs.writeFileSync(MARKING_GROUPS_FILE, JSON.stringify({
      generatedAt: new Date().toISOString(),
      source: 'web-service',
      groups
    }, null, 2));
  } catch (_) {
  }
}

function latestAnalyticsJson() {
  const latest = path.join(OUTPUT_DIR, 'analytics-latest.json');
  if (fs.existsSync(latest)) return latest;

  if (!fs.existsSync(OUTPUT_DIR)) return null;
  const files = fs.readdirSync(OUTPUT_DIR)
    .filter((name) => /^analytics-.*\.json$/i.test(name))
    .map((name) => path.join(OUTPUT_DIR, name))
    .sort();

  return files.at(-1) || null;
}

function makeDate(year, month, day) {
  return new Date(year, month - 1, day, 12, 0, 0, 0);
}

function parseDateFromEnv(value, fallbackIso) {
  let raw = norm(value || fallbackIso);
  if (/^\d{2}-\d{2}$/.test(raw)) {
    raw = `${fallbackIso.slice(0, 4)}-${raw}`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    raw = fallbackIso;
  }
  const [yy, mm, dd] = raw.split('-').map((x) => Number(x));
  if (!Number.isFinite(yy) || !Number.isFinite(mm) || !Number.isFinite(dd)) {
    const [fy, fm, fd] = fallbackIso.split('-').map((x) => Number(x));
    return makeDate(fy, fm, fd);
  }
  return makeDate(yy, mm, dd);
}

function isDateInRange(date, start, end) {
  return date >= start && date <= end;
}

const MONTH_MAP = {
  'янв': 1,
  'фев': 2,
  'мар': 3,
  'апр': 4,
  'мая': 5,
  'май': 5,
  'июн': 6,
  'июл': 7,
  'авг': 8,
  'сен': 9,
  'окт': 10,
  'ноя': 11,
  'дек': 12
};

function monthToNumber(rawMonth) {
  const key = norm(rawMonth).toLowerCase().slice(0, 3);
  return MONTH_MAP[key] || null;
}

function parseDay(rawDay) {
  const m = String(rawDay || '').match(/(\d{1,2})/);
  if (!m) return null;
  const day = Number(m[1]);
  return Number.isFinite(day) ? day : null;
}

function parseDayFromPeriod(period) {
  const head = String(period || '').split('#')[0];
  const m = head.match(/\b([0-3]?\d)\b/);
  if (!m) return null;
  const day = Number(m[1]);
  if (!Number.isFinite(day) || day < 1 || day > 31) return null;
  return day;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatDateRu(date) {
  return `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}.${date.getFullYear()}`;
}

function extractSlot(period) {
  const m = String(period || '').match(/#(\d+)/);
  return m ? Number(m[1]) : null;
}

const TRIMESTERS = [
  {
    name: process.env.TRIMESTER_1_LABEL || '1 триместр',
    start: parseDateFromEnv(process.env.TRIMESTER_1_START, '2025-09-01'),
    end: parseDateFromEnv(process.env.TRIMESTER_1_END, '2025-11-30')
  },
  {
    name: process.env.TRIMESTER_2_LABEL || '2 триместр',
    start: parseDateFromEnv(process.env.TRIMESTER_2_START, '2025-12-01'),
    end: parseDateFromEnv(process.env.TRIMESTER_2_END, '2026-02-28')
  },
  {
    name: process.env.TRIMESTER_3_LABEL || '3 триместр',
    start: parseDateFromEnv(process.env.TRIMESTER_3_START, '2026-03-01'),
    end: parseDateFromEnv(process.env.TRIMESTER_3_END, '2026-05-23')
  }
];

function detectCurrentTrimester() {
  const now = new Date();
  for (const t of TRIMESTERS) {
    if (isDateInRange(now, t.start, t.end)) return t.name;
  }
  return TRIMESTERS[TRIMESTERS.length - 1].name;
}

const CURRENT_TRIMESTER_LABEL = process.env.CURRENT_TRIMESTER_LABEL || detectCurrentTrimester();
let hiddenStudents = loadHiddenStudents();

function detectTrimesterByDate(date) {
  for (const t of TRIMESTERS) {
    if (isDateInRange(date, t.start, t.end)) return t.name;
  }
  return 'Вне триместров';
}

function detectTrimesterFromExplicitTag(row) {
  const blob = `${norm(row.day)} ${norm(row.period)} ${norm(row.month)}`.toLowerCase();
  if (!blob) return null;

  if (/\b1\s*т\b|\bi\b|\b1\s*тр/i.test(blob)) return TRIMESTERS[0]?.name || '1 триместр';
  if (/\b2\s*т\b|\bii\b|\b2\s*тр/i.test(blob)) return TRIMESTERS[1]?.name || '2 триместр';
  if (/\b3\s*т\b|\biii\b|\b3\s*тр/i.test(blob)) return TRIMESTERS[2]?.name || '3 триместр';
  return null;
}

function canonicalTrimesterLabel(label) {
  const raw = norm(label).toLowerCase();
  if (!raw) return '';
  if (/(^|\s)1(\s|$)|\b1\s*тр|\b1\s*т/.test(raw)) return TRIMESTERS[0]?.name || '1 триместр';
  if (/(^|\s)2(\s|$)|\b2\s*тр|\b2\s*т/.test(raw)) return TRIMESTERS[1]?.name || '2 триместр';
  if (/(^|\s)3(\s|$)|\b3\s*тр|\b3\s*т/.test(raw)) return TRIMESTERS[2]?.name || '3 триместр';
  return norm(label);
}

function inferDateFromRow(row) {
  let month = monthToNumber(row.month);
  let day = parseDay(row.day);
  if (!month) {
    month = String(row.period || '')
      .toLowerCase()
      .split(/\s+/)
      .map((t) => monthToNumber(t))
      .find((x) => Number.isFinite(x)) || null;
  }
  if (!day) {
    day = parseDayFromPeriod(row.period) || 15;
  }
  if (!month || !day) return null;

  for (const t of TRIMESTERS) {
    const years = [...new Set([t.start.getFullYear(), t.end.getFullYear()])];
    for (const year of years) {
      const d = makeDate(year, month, day);
      if (isDateInRange(d, t.start, t.end)) {
        return d;
      }
    }
  }

  const fallbackStartYear = TRIMESTERS[0].start.getFullYear();
  const fallbackYear = month >= 9 ? fallbackStartYear : fallbackStartYear + 1;
  return makeDate(fallbackYear, month, day);
}

function buildMarkTooltip(row, dateObj) {
  const explicitTri = detectTrimesterFromExplicitTag(row);
  if (!dateObj && explicitTri) {
    return `Итог: ${explicitTri}`;
  }
  if (dateObj) {
    const slot = extractSlot(row.period);
    if (slot) return `${formatDateRu(dateObj)}, урок ${slot}`;
    return formatDateRu(dateObj);
  }
  return norm(row.period) || 'Без даты';
}

function buildSubjectRows(rows) {
  const bySubject = new Map();
  let seq = 0;

  for (const row of rows) {
    const subject = norm(row.subject) || 'Неизвестный предмет';
    if (!bySubject.has(subject)) {
      bySubject.set(subject, {
        subject,
        marksCount: 0,
        gradesCount: 0,
        gradesSum: 0,
        gradesWeight: 0,
        absencesCount: 0,
        marksByTrimester: new Map(),
        trimesterStats: new Map(),
        explicitTrimesterMarks: new Map()
      });
    }

    const item = bySubject.get(subject);
    const mark = norm(row.mark);
    const isAbsence = String(mark).toLowerCase() === 'н';

    const explicitTri = detectTrimesterFromExplicitTag(row);
    const dateObj = inferDateFromRow(row);
    const finalTrimester = canonicalTrimesterLabel(row.trimesterLabel);
    const isFinalTrimesterMark = row.markType === 'final_trimester' && finalTrimester && Number.isFinite(Number(row.numericMark));
    const trimester = finalTrimester || explicitTri || (dateObj ? detectTrimesterByDate(dateObj) : 'Без триместра');
    const tooltip = buildMarkTooltip(row, dateObj);
    const weightRaw = Number(row.weight);
    const weight = Number.isFinite(weightRaw) && weightRaw > 0 ? weightRaw : 1;

    if (isFinalTrimesterMark) {
      item.explicitTrimesterMarks.set(finalTrimester, Number(row.numericMark));
      continue;
    }
    const slot = extractSlot(row.period) || 0;

    if (isAbsence) {
      item.absencesCount += 1;
      continue;
    }

    item.marksCount += 1;

    if (!item.marksByTrimester.has(trimester)) item.marksByTrimester.set(trimester, []);
    item.marksByTrimester.get(trimester).push({
      mark,
      weight,
      tooltip: weight > 1 ? `${tooltip}, коэф. ${weight}` : tooltip,
      ts: dateObj ? dateObj.getTime() : Number.MAX_SAFE_INTEGER,
      slot,
      seq: seq++
    });

    const num = Number(row.numericMark);
    if (Number.isFinite(num)) {
      item.gradesCount += 1;
      item.gradesSum += num * weight;
      item.gradesWeight += weight;

      if (!item.trimesterStats.has(trimester)) item.trimesterStats.set(trimester, { sum: 0, weight: 0, count: 0 });
      const st = item.trimesterStats.get(trimester);
      st.sum += num * weight;
      st.weight += weight;
      st.count += 1;
    }
  }

  const knownTrimesterOrder = TRIMESTERS.map((t) => t.name);
  const sortTrimester = (a, b) => {
    const ai = knownTrimesterOrder.indexOf(a[0]);
    const bi = knownTrimesterOrder.indexOf(b[0]);
    const av = ai >= 0 ? ai : 999;
    const bv = bi >= 0 ? bi : 999;
    return av - bv || a[0].localeCompare(b[0], 'ru');
  };

  return [...bySubject.values()]
    .map((s) => {
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
      for (const t of TRIMESTERS) {
        const explicit = s.explicitTrimesterMarks.get(t.name);
        const st = s.trimesterStats.get(t.name);
        if (Number.isFinite(explicit)) {
          trimesterAverages[t.name] = Number(explicit);
          trimesterSource[t.name] = 'final';
        } else if (st && st.weight > 0) {
          trimesterAverages[t.name] = Number((st.sum / st.weight).toFixed(2));
          trimesterSource[t.name] = 'calculated';
        } else {
          trimesterAverages[t.name] = null;
          trimesterSource[t.name] = null;
        }
        trimesterRounded[t.name] = Number.isFinite(trimesterAverages[t.name])
          ? Math.round(trimesterAverages[t.name])
          : null;
      }

      const roundedValues = Object.values(trimesterRounded).filter((v) => Number.isFinite(v));
      const annualFromRoundedTrimesters = roundedValues.length
        ? Number((roundedValues.reduce((acc, v) => acc + v, 0) / roundedValues.length).toFixed(2))
        : null;

      const allMarks = [...s.marksByTrimester.values()]
        .flat()
        .filter((m) => { const n = Number.parseFloat(m.mark); return Number.isFinite(n); })
        .sort((a, b) => (a.ts - b.ts) || (a.slot - b.slot) || (a.seq - b.seq));
      const weightedMarks = [];
      for (const m of allMarks) {
        const wRaw = Number(m.weight);
        const w = Number.isFinite(wRaw) && wRaw > 0 ? Math.max(1, Math.round(wRaw)) : 1;
        for (let i = 0; i < w; i += 1) weightedMarks.push(m);
      }
      let trend = null;
      let trendDiff = null;
      if (weightedMarks.length >= TREND_WINDOW) {
        const recent = weightedMarks.slice(-TREND_WINDOW);
        const half = Math.floor(TREND_WINDOW / 2);
        const first = recent.slice(0, half);
        const second = recent.slice(-half);
        const avg = (arr) => arr.reduce((s, m) => s + Number.parseFloat(m.mark), 0) / arr.length;
        const diff = avg(second) - avg(first);
        if (diff > 1) { trend = 'up'; trendDiff = diff; }
        else if (diff < -1) { trend = 'down'; trendDiff = diff; }
      }

      return {
        subject: s.subject,
        marksCount: s.marksCount,
        gradesCount: s.gradesCount,
        absencesCount: s.absencesCount,
        averageGrade: annualFromRoundedTrimesters,
        averageGradeRaw: s.gradesWeight > 0 ? Number((s.gradesSum / s.gradesWeight).toFixed(2)) : null,
        trend,
        trendDiff: trendDiff !== null ? Number(trendDiff.toFixed(2)) : null,
        trimesterAverages,
        trimesterRounded,
        trimesterSource,
        marksByTrimester: [...s.marksByTrimester.entries()]
          .sort(sortTrimester)
          .map(([trimester, marks]) => ({
            trimester,
            marks: [...marks]
              .sort((a, b) => (a.ts - b.ts) || (a.slot - b.slot) || (a.seq - b.seq))
              .map((m) => ({ mark: m.mark, weight: m.weight, tooltip: m.tooltip }))
          }))
      };
    })
    .sort((a, b) => a.subject.localeCompare(b.subject, 'ru'));
}

function buildStudentCard(name, rows) {
  const subjectRows = buildSubjectRows(rows);
  const annualValues = subjectRows
    .map((s) => s.averageGrade)
    .filter((v) => Number.isFinite(v));
  const averageGrade = annualValues.length
    ? Number((annualValues.reduce((acc, v) => acc + v, 0) / annualValues.length).toFixed(2))
    : null;

  const currentValues = subjectRows
    .map((s) => s.trimesterAverages?.[CURRENT_TRIMESTER_LABEL])
    .filter((v) => Number.isFinite(v));
  const currentTrimesterAverage = currentValues.length
    ? Number((currentValues.reduce((acc, v) => acc + v, 0) / currentValues.length).toFixed(2))
    : null;

  const currentTrimesterRiskSubjects = subjectRows
    .filter((s) => {
      const v = s.trimesterAverages[CURRENT_TRIMESTER_LABEL];
      return Number.isFinite(v) && Math.round(v) < 7;
    })
    .map((s) => s.subject);

  const yearRiskSubjects = subjectRows
    .filter((s) => Number.isFinite(s.averageGrade) && Math.round(s.averageGrade) < 7)
    .map((s) => s.subject);

  const trendValues = subjectRows.map((s) => s.trend).filter(Boolean);
  const ups = trendValues.filter((t) => t === 'up').length;
  const downs = trendValues.filter((t) => t === 'down').length;
  const averageTrend = ups > downs ? 'up' : downs > ups ? 'down' : null;

  return {
    name,
    averageGrade,
    currentTrimesterAverage,
    averageTrend,
    warningCurrentTrimester: currentTrimesterRiskSubjects.length > 0,
    warningYear: yearRiskSubjects.length > 0,
    currentTrimesterRiskSubjects,
    yearRiskSubjects
  };
}

function loadDataset() {
  const filePath = latestAnalyticsJson();
  if (!filePath) {
    return {
      generatedAt: new Date().toISOString(),
      sourceFile: null,
      reportsDir: null,
      filesCount: 0,
      students: [],
      byStudent: {},
      rowsCount: 0,
      studentCards: []
    };
  }

  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const students = Array.isArray(raw.students) ? raw.students : [];
  const byStudent = raw.byStudent && typeof raw.byStudent === 'object' ? raw.byStudent : {};

  const studentCards = students.map((name) => {
    const card = buildStudentCard(name, Array.isArray(byStudent[name]) ? byStudent[name] : []);
    return { ...card, hidden: hiddenStudents.has(norm(name)) };
  });

  return {
    generatedAt: raw.generatedAt,
    sourceFile: filePath,
    reportsDir: raw.reportsDir || null,
    filesCount: Number(raw.filesCount || 0),
    students,
    byStudent,
    rowsCount: Number(raw.rowsCount || 0),
    studentCards
  };
}

let dataset = loadDataset();

let markingSession = null;
let markingAuthHintShown = false;

function parseIdList(raw) {
  return String(raw || '')
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n));
}

function normalizeName(v) {
  return norm(v).toLowerCase().replace(/ё/g, 'е');
}

function pickStudentName(profile) {
  const fio = [profile.last_name, profile.first_name, profile.middle_name]
    .map((x) => norm(x))
    .filter(Boolean)
    .join(' ');
  if (fio) return fio;
  return norm(profile.short_name || profile.user_name || `ID ${profile.id}`);
}

function splitNameMarksText(raw) {
  const lines = String(raw || '').replace(/\r/g, '').split('\n');
  if (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines;
}

function parseGradeLine(value) {
  const s = norm(value);
  if (!s) return null;
  if (!/^\d+$/.test(s)) throw new Error(`Недопустимая отметка "${value}" (только 1-10 или пусто)`);
  const n = Number(s);
  if (!Number.isFinite(n) || n < 1 || n > 10) {
    throw new Error(`Недопустимая отметка "${value}" (только 1-10 или пусто)`);
  }
  return n;
}

function isoDateToday() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

function findThemeIntegrationId(scheduleItem) {
  const didactic = Array.isArray(scheduleItem?.didactic_units) ? scheduleItem.didactic_units : [];
  const fromDidactic = didactic
    .map((x) => Number(x.theme_integration_id))
    .find((x) => Number.isFinite(x));
  if (Number.isFinite(fromDidactic)) return String(fromDidactic);
  const direct = Number(scheduleItem?.theme_frame_integration_id);
  if (Number.isFinite(direct)) return String(direct);
  return null;
}

function pickPracticalLesson(items) {
  const now = Date.now();
  const practical = items
    .filter((it) => {
      const ts = Date.parse(String(it.iso_date_time || ''));
      if (!Number.isFinite(ts) || ts > now) return false;
      const lessonName = String(it.lesson_name || '').toLowerCase();
      const topicName = String(it.topic_name || '').toLowerCase();
      return /практич/.test(lessonName) || /практич/.test(topicName);
    })
    .sort((a, b) => {
      const at = Date.parse(String(a.iso_date_time || '')) || 0;
      const bt = Date.parse(String(b.iso_date_time || '')) || 0;
      return bt - at;
    });
  return practical[0] || null;
}

function pickPracticalControlForm(forms) {
  const list = Array.isArray(forms) ? forms : [];
  const filtered = list.filter((f) => {
    const title = `${norm(f.name)} ${norm(f.short_name)}`.toLowerCase();
    const nmax = Number(f?.grade_system?.nmax);
    return /практич/.test(title) && Number.isFinite(nmax) && nmax >= 10;
  });
  filtered.sort((a, b) => Number(b.id || 0) - Number(a.id || 0));
  return filtered[0] || null;
}

async function getMarkingSession() {
  const readAuthFromContext = async (ctx) => {
    const cookies = await ctx.cookies();
    const byName = new Map(cookies.map((c) => [c.name, c.value]));
    const bearerToken = process.env.API_BEARER_TOKEN || byName.get('aupd_token') || '';
    const profileId = process.env.API_PROFILE_ID || byName.get('profile_id') || byName.get('profileId') || '';
    const roleId = process.env.API_ROLE_ID || '9';
    const hostId = process.env.API_HOST_ID || '9';
    const aid = process.env.API_AID || '13';
    if (!bearerToken || !profileId) return null;
    return { bearerToken, profileId, roleId, hostId, aid };
  };

  if (!markingSession) {
    fs.mkdirSync(MARKING_PROFILE_DIR, { recursive: true });
    const context = await chromium.launchPersistentContext(MARKING_PROFILE_DIR, { headless: MARKING_HEADLESS });
    context.setDefaultTimeout(MARKING_TIMEOUT_MS);
    const page = await context.newPage();

    markingSession = {
      context,
      page,
      auth: null,
      opts: {
        academicYearId: Number(process.env.API_ACADEMIC_YEAR_ID),
        schoolId: Number(process.env.API_SCHOOL_ID),
        classUnitIds: parseIdList(process.env.API_CLASS_UNIT_IDS),
        groupsPerPage: Number(process.env.API_GROUPS_PER_PAGE || 300),
        groupsSource: String(process.env.MARKING_GROUPS_SOURCE || 'teacher').toLowerCase()
      }
    };
  }

  if (!markingSession.auth) {
    markingSession.auth = await readAuthFromContext(markingSession.context);
  }

  if (!markingSession.auth) {
    const loginUrl = process.env.MESH_LOGIN_URL || 'https://school.mos.ru/';
    const targetUrl = process.env.MESH_MENTOR_JOURNALS_URL || 'https://school.mos.ru/teacher/mentor/journals';
    try {
      await markingSession.page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
      await markingSession.page.waitForTimeout(1500);
    } catch (_) {
      try {
        await markingSession.page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
      } catch (_) {
      }
    }

    if (!markingAuthHintShown) {
      markingAuthHintShown = true;
      console.log('[marking] API session missing: browser opened for login. Finish login/2FA and retry in UI.');
    }
    throw new Error('Сессия не найдена: открыл окно браузера. Войдите в МЭШ (2FA) и нажмите «Предпросмотр»/загрузку групп еще раз.');
  }

  return markingSession;
}

async function closeMarkingSession() {
  if (!markingSession) return;
  const ctx = markingSession.context;
  markingSession = null;
  markingAuthHintShown = false;
  try {
    await ctx.close();
  } catch (_) {
  }
}

function runSyncViaSession(auth) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'download-reports.js')], {
      stdio: 'inherit',
      env: {
        ...process.env,
        API_BEARER_TOKEN: String(auth?.bearerToken || process.env.API_BEARER_TOKEN || ''),
        API_PROFILE_ID: String(auth?.profileId || process.env.API_PROFILE_ID || ''),
        SYNC_NO_BROWSER_AUTH: 'true',
        MANUAL_LOGIN: 'false',
        USE_PERSISTENT_PROFILE: 'true'
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`Sync process failed, code=${code}`));
    });
  });
}

async function loadMarkingGroups() {
  const session = await getMarkingSession();
  const { page, auth, opts } = session;
  let groups = [];

  if (opts.groupsSource === 'teacher') {
    try {
      const teacher = await fetchTeacherProfile(page.request, auth, Number(auth.profileId));
      const rawGroupIds = Array.isArray(teacher?.assigned_group_ids) && teacher.assigned_group_ids.length
        ? teacher.assigned_group_ids
        : teacher?.group_ids;
      const groupIds = Array.isArray(rawGroupIds)
        ? rawGroupIds.map((x) => Number(x)).filter((x) => Number.isFinite(x))
        : [];
      if (groupIds.length) {
        groups = await fetchPlanGroupsByGroupIds(page.request, auth, {
          academicYearId: opts.academicYearId,
          schoolId: opts.schoolId,
          groupIds,
          perPage: opts.groupsPerPage
        });
      }
    } catch (_) {
      groups = [];
    }
  }

  if (!groups.length) {
    groups = await fetchPlanGroups(page.request, auth, {
      academicYearId: opts.academicYearId,
      schoolId: opts.schoolId,
      classUnitIds: opts.classUnitIds,
      perPage: opts.groupsPerPage
    });
  }

  const prepared = groups
    .filter((g) => Number(g.student_count || 0) > 0)
    .filter((g) => !g.is_metagroup)
    .map((g) => ({
      id: Number(g.id),
      name: norm(g.name),
      subjectName: norm(g.subject_name),
      classUnitName: norm(g.class_unit_name),
      studentCount: Number(g.student_count || 0),
      subjectId: Number(g.subject_id),
      classLevelId: Number(g.class_level_id),
      canMark: true
    }))
    .filter((g) => Number.isFinite(g.id));
  saveCachedMarkingGroups(prepared);
  return prepared;
}

async function buildMarkingPreview(payload) {
  const groupId = Number(payload.groupId);
  const comment = String(payload.comment || '');
  if (!Number.isFinite(groupId)) throw new Error('groupId is required');

  const names = splitNameMarksText(payload.namesText);
  const marks = splitNameMarksText(payload.marksText);
  if (names.length !== marks.length) {
    throw new Error(`Количество строк не совпадает: ФИО=${names.length}, отметки=${marks.length}`);
  }
  if (!names.length) throw new Error('Введите хотя бы одну строку с ФИО');

  const parsedRows = names.map((fullName, idx) => {
    const nameNorm = norm(fullName);
    if (!nameNorm) throw new Error(`Пустая строка ФИО в позиции ${idx + 1}`);
    const nameParts = nameNorm.split(' ');
    if (nameParts.length < 2) throw new Error(`Неверный формат ФИО в строке ${idx + 1}: "${fullName}"`);
    const grade = parseGradeLine(marks[idx]);
    return {
      line: idx + 1,
      inputName: nameNorm,
      inputNameNorm: normalizeName(nameNorm),
      grade
    };
  });

  const session = await getMarkingSession();
  const { page, auth, opts } = session;

  const group = await fetchGroupById(page.request, auth, groupId);
  const subjectId = Number(group.subject_id);
  const classLevelId = Number(group.class_level_id);
  const classUnitIds = Array.isArray(group.class_unit_ids) && group.class_unit_ids.length
    ? group.class_unit_ids.map((x) => Number(x)).filter((x) => Number.isFinite(x))
    : opts.classUnitIds;

  const profiles = await fetchGroupStudentProfiles(page.request, auth, {
    academicYearId: opts.academicYearId,
    classUnitIds,
    groupId,
    perPage: 200
  });

  const nameIndex = new Map();
  for (const p of profiles) {
    const id = Number(p.id);
    if (!Number.isFinite(id)) continue;
    const userName = pickStudentName(p);
    const keyMain = normalizeName(userName);
    if (keyMain) {
      if (!nameIndex.has(keyMain)) nameIndex.set(keyMain, []);
      nameIndex.get(keyMain).push({ id, userName, profile: p });
    }

    const short = norm(p.short_name);
    const keyShort = normalizeName(short);
    if (keyShort) {
      if (!nameIndex.has(keyShort)) nameIndex.set(keyShort, []);
      nameIndex.get(keyShort).push({ id, userName, profile: p });
    }

    const fio2 = [norm(p.last_name), norm(p.first_name)].filter(Boolean).join(' ');
    const keyFio2 = normalizeName(fio2);
    if (keyFio2) {
      if (!nameIndex.has(keyFio2)) nameIndex.set(keyFio2, []);
      nameIndex.get(keyFio2).push({ id, userName, profile: p });
    }
  }

  const yearStart = `${new Date().getFullYear() - 1}-09-01`;
  const scheduleItems = await fetchScheduleItemsByGroup(page.request, auth, {
    academicYearId: opts.academicYearId,
    groupId,
    from: yearStart,
    to: isoDateToday(),
    perPage: 300
  });
  const lesson = pickPracticalLesson(scheduleItems);
  if (!lesson) {
    throw new Error('Не найден прошедший урок с типом "Практическая работа"');
  }

  const controlForms = await fetchControlForms(page.request, auth, {
    academicYearId: opts.academicYearId,
    schoolId: opts.schoolId,
    subjectId,
    classLevelId
  });
  const practicalControlForm = pickPracticalControlForm(controlForms);
  if (!practicalControlForm) {
    throw new Error('Для предмета не найдена форма контроля "Практическая работа" с 10-балльной шкалой');
  }

  const scheduleLessonId = Number(lesson.id);
  const themeFrameIntegrationId = findThemeIntegrationId(lesson);
  const controlFormId = Number(practicalControlForm.id);
  const gradeSystemId = Number(practicalControlForm?.grade_system?.id || practicalControlForm.grade_system_id);
  if (!Number.isFinite(scheduleLessonId) || !Number.isFinite(controlFormId) || !Number.isFinite(gradeSystemId)) {
    throw new Error('Не удалось собрать обязательные параметры урока/шкалы');
  }

  const rows = parsedRows.map((r) => {
    const hit = nameIndex.get(r.inputNameNorm) || [];
    const uniq = new Map(hit.map((x) => [x.id, x]));
    const matches = [...uniq.values()];
    if (!matches.length) {
      return {
        line: r.line,
        inputName: r.inputName,
        status: 'skip_not_in_group',
        reason: 'Ученик не найден в выбранной группе',
        grade: r.grade
      };
    }
    if (matches.length > 1) {
      return {
        line: r.line,
        inputName: r.inputName,
        status: 'error',
        reason: 'Найдено несколько учеников с таким именем в группе',
        grade: r.grade
      };
    }
    const student = matches[0];
    if (r.grade === null) {
      return {
        line: r.line,
        inputName: r.inputName,
        studentProfileId: Number(student.id),
        studentName: student.userName,
        status: 'skip_empty_grade',
        reason: 'Пустая отметка в строке',
        grade: null
      };
    }

    return {
      line: r.line,
      inputName: r.inputName,
      studentProfileId: Number(student.id),
      studentName: student.userName,
      status: 'ready',
      reason: '',
      grade: r.grade
    };
  });

  return {
    group: {
      id: groupId,
      name: norm(group.name),
      subjectName: norm(group.subject_name)
    },
    lesson: {
      scheduleLessonId,
      isoDateTime: lesson.iso_date_time,
      lessonName: norm(lesson.lesson_name),
      themeFrameIntegrationId: themeFrameIntegrationId || null
    },
    controlForm: {
      id: controlFormId,
      name: norm(practicalControlForm.name),
      gradeSystemId
    },
    comment,
    rows,
    summary: {
      ready: rows.filter((x) => x.status === 'ready').length,
      skipNotInGroup: rows.filter((x) => x.status === 'skip_not_in_group').length,
      skipEmpty: rows.filter((x) => x.status === 'skip_empty_grade').length,
      errors: rows.filter((x) => x.status === 'error').length
    }
  };
}

async function applyMarkingPreview(preview) {
  const session = await getMarkingSession();
  const { page, auth } = session;
  const teacherId = Number(auth.profileId);
  if (!Number.isFinite(teacherId)) throw new Error('Некорректный teacher/profile id');

  const scheduleLessonId = Number(preview?.lesson?.scheduleLessonId);
  const controlFormId = Number(preview?.controlForm?.id);
  const gradeSystemId = Number(preview?.controlForm?.gradeSystemId);
  const themeFrameIntegrationId = preview?.lesson?.themeFrameIntegrationId || null;
  const comment = String(preview?.comment || '');
  const rows = Array.isArray(preview?.rows) ? preview.rows : [];

  const results = [];
  for (const row of rows) {
    if (row.status !== 'ready') {
      results.push({
        line: row.line,
        inputName: row.inputName,
        status: row.status,
        reason: row.reason || ''
      });
      continue;
    }

    const payload = {
      comment,
      is_exam: false,
      is_criterion: false,
      is_point: false,
      point_date: '',
      schedule_lesson_id: scheduleLessonId,
      student_profile_id: Number(row.studentProfileId),
      teacher_id: teacherId,
      control_form_id: controlFormId,
      weight: 1,
      theme_frame_integration_id: themeFrameIntegrationId,
      course_lesson_topic_id: null,
      grade_origins: [{ grade_origin: String(row.grade), grade_system_id: gradeSystemId }],
      grade_system_type: false,
      mark_type_id: 1
    };

    try {
      const created = await createMark(page.request, auth, payload);
      results.push({
        line: row.line,
        inputName: row.inputName,
        studentName: row.studentName,
        status: 'created',
        markId: Number(created?.id) || null
      });
    } catch (err) {
      results.push({
        line: row.line,
        inputName: row.inputName,
        studentName: row.studentName,
        status: 'error',
        reason: err.message
      });
    }
  }

  return {
    ok: true,
    summary: {
      created: results.filter((x) => x.status === 'created').length,
      skipped: results.filter((x) => x.status.startsWith('skip_')).length,
      errors: results.filter((x) => x.status === 'error').length
    },
    results
  };
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += String(chunk || '');
      if (raw.length > 1024 * 1024) {
        reject(new Error('Request body is too large'));
      }
    });
    req.on('end', () => {
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (_) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendFile(res, filePath, contentType) {
  if (!fs.existsSync(filePath)) {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  const body = fs.readFileSync(filePath);
  res.writeHead(200, {
    'Content-Type': contentType,
    'Content-Length': body.length
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/meta') {
    const visibleCount = dataset.studentCards.filter((s) => !s.hidden).length;
    return sendJson(res, 200, {
      generatedAt: dataset.generatedAt,
      sourceFile: dataset.sourceFile,
      reportsDir: dataset.reportsDir,
      filesCount: dataset.filesCount,
      studentsCount: dataset.students.length,
      visibleStudentsCount: visibleCount,
      hiddenStudentsCount: dataset.students.length - visibleCount,
      rowsCount: dataset.rowsCount,
      trimesterLabels: TRIMESTERS.map((t) => t.name),
      currentTrimesterLabel: CURRENT_TRIMESTER_LABEL,
      trendWindow: TREND_WINDOW
    });
  }

  if (url.pathname === '/api/reload') {
    dataset = loadDataset();
    return sendJson(res, 200, {
      ok: true,
      generatedAt: dataset.generatedAt,
      studentsCount: dataset.students.length,
      filesCount: dataset.filesCount,
      rowsCount: dataset.rowsCount
    });
  }

  if (url.pathname === '/api/students') {
    const includeHidden = url.searchParams.get('include_hidden') === '1';
    const q = norm(url.searchParams.get('q')).toLowerCase();
    let items = q
      ? dataset.studentCards.filter((s) => s.name.toLowerCase().includes(q))
      : dataset.studentCards;
    if (!includeHidden) {
      items = items.filter((s) => !s.hidden);
    }
    return sendJson(res, 200, {
      students: items,
      currentTrimesterLabel: CURRENT_TRIMESTER_LABEL,
      includeHidden
    });
  }

  if (url.pathname === '/api/student-visibility' && req.method === 'POST') {
    return readJsonBody(req)
      .then((body) => {
        const name = norm(body.name);
        const hidden = Boolean(body.hidden);
        if (!name) {
          return sendJson(res, 400, { ok: false, error: 'name is required' });
        }

        if (hidden) hiddenStudents.add(name);
        else hiddenStudents.delete(name);
        saveHiddenStudents(hiddenStudents);

        dataset = loadDataset();
        const updated = dataset.studentCards.find((s) => norm(s.name) === name);
        return sendJson(res, 200, {
          ok: true,
          name,
          hidden,
          student: updated || null
        });
      })
      .catch((err) => sendJson(res, 400, { ok: false, error: err.message }));
  }

  if (url.pathname === '/api/marking/groups') {
    return loadMarkingGroups()
      .then((groups) => sendJson(res, 200, { groups, source: 'live' }))
      .catch((err) => {
        const cached = loadCachedMarkingGroups();
        if (cached.length) {
          return sendJson(res, 200, {
            groups: cached,
            source: 'cache',
            warning: `Live API unavailable: ${err.message}`
          });
        }
        return sendJson(res, 400, { error: err.message });
      });
  }

  if (url.pathname === '/api/marking/preview' && req.method === 'POST') {
    return readJsonBody(req)
      .then((body) => buildMarkingPreview(body))
      .then((preview) => sendJson(res, 200, { preview }))
      .catch((err) => sendJson(res, 400, { error: err.message }));
  }

  if (url.pathname === '/api/marking/apply' && req.method === 'POST') {
    return readJsonBody(req)
      .then((body) => applyMarkingPreview(body.preview))
      .then((result) => sendJson(res, 200, result))
      .catch((err) => sendJson(res, 400, { error: err.message }));
  }

  if (url.pathname.startsWith('/api/student/')) {
    const student = decodeURIComponent(url.pathname.replace('/api/student/', ''));
    const rows = Array.isArray(dataset.byStudent[student]) ? dataset.byStudent[student] : [];
    const subjectRows = buildSubjectRows(rows);
    return sendJson(res, 200, {
      student,
      rows,
      subjectRows,
      totalMarks: rows.length,
      subjectsCount: subjectRows.length,
      trimesterLabels: TRIMESTERS.map((t) => t.name),
      currentTrimesterLabel: CURRENT_TRIMESTER_LABEL
    });
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    return sendFile(res, path.join(WEB_DIR, 'index.html'), 'text/html; charset=utf-8');
  }

  return sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  console.log(`Web UI: http://localhost:${PORT}`);
  console.log(`Students loaded: ${dataset.students.length}`);
  console.log(`Analytics file: ${dataset.sourceFile || 'none'}`);

  (async () => {
    let session = null;
    if (MARKING_PREOPEN_ON_START || START_SYNC_ON_START) {
      console.log('[marking] Pre-open API session on start...');
      try {
        session = await getMarkingSession();
        console.log('[marking] API session is ready.');
      } catch (err) {
        console.log(`[marking] Session is not ready yet: ${err.message}`);
        if (START_SYNC_ON_START && START_SYNC_STRICT) {
          console.error('[start] Strict sync is enabled and session is unavailable. Exiting.');
          process.exit(1);
        }
      }
    }

    if (START_SYNC_ON_START) {
      if (!session || !session.auth) {
        const msg = '[start] Skip sync: API session is unavailable.';
        if (START_SYNC_STRICT) {
          console.error(`${msg} Strict mode enabled.`);
          process.exit(1);
        } else {
          console.log(`${msg} Continue with existing analytics.`);
        }
        return;
      }
      console.log('[start] Sync analytics via current API session...');
      try {
        await runSyncViaSession(session.auth);
        dataset = loadDataset();
        console.log(`[start] Sync done. Students loaded: ${dataset.students.length}`);
      } catch (err) {
        if (START_SYNC_STRICT) {
          console.error(`[start] Sync failed: ${err.message}`);
          process.exit(1);
        } else {
          console.log(`[start] Sync failed: ${err.message}`);
          console.log('[start] Continue with existing analytics.');
        }
      }
    }
  })().catch((err) => {
    console.error(`[start] Unexpected startup error: ${err.message}`);
    if (START_SYNC_STRICT) process.exit(1);
  });
});

process.on('SIGINT', async () => {
  await closeMarkingSession();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await closeMarkingSession();
  process.exit(0);
});
