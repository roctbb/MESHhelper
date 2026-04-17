const fs = require('fs');
const path = require('path');
const http = require('http');
require('dotenv').config();

const ROOT = __dirname;
const OUTPUT_DIR = path.join(ROOT, 'output');
const WEB_DIR = path.join(ROOT, 'web');
const PORT = Number(process.env.WEB_PORT || '8787');
const VISIBILITY_FILE = path.join(OUTPUT_DIR, 'student-visibility.json');
const TREND_WINDOW = Math.max(2, Number(process.env.TREND_WINDOW) || 5);

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
        absencesCount: 0,
        marksByTrimester: new Map(),
        trimesterStats: new Map()
      });
    }

    const item = bySubject.get(subject);
    const mark = norm(row.mark);
    const isAbsence = String(mark).toLowerCase() === 'н';

    const explicitTri = detectTrimesterFromExplicitTag(row);
    const dateObj = inferDateFromRow(row);
    const trimester = explicitTri || (dateObj ? detectTrimesterByDate(dateObj) : 'Без триместра');
    const tooltip = buildMarkTooltip(row, dateObj);
    const slot = extractSlot(row.period) || 0;

    if (isAbsence) {
      item.absencesCount += 1;
      continue;
    }

    item.marksCount += 1;

    if (!item.marksByTrimester.has(trimester)) item.marksByTrimester.set(trimester, []);
    item.marksByTrimester.get(trimester).push({
      mark,
      tooltip,
      ts: dateObj ? dateObj.getTime() : Number.MAX_SAFE_INTEGER,
      slot,
      seq: seq++
    });

    const num = Number(row.numericMark);
    if (Number.isFinite(num)) {
      item.gradesCount += 1;
      item.gradesSum += num;

      if (!item.trimesterStats.has(trimester)) item.trimesterStats.set(trimester, { sum: 0, count: 0 });
      const st = item.trimesterStats.get(trimester);
      st.sum += num;
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
      for (const t of TRIMESTERS) {
        const st = s.trimesterStats.get(t.name);
        trimesterAverages[t.name] = st && st.count > 0 ? Number((st.sum / st.count).toFixed(2)) : null;
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
      let trend = null;
      let trendDiff = null;
      if (allMarks.length >= TREND_WINDOW) {
        const recent = allMarks.slice(-TREND_WINDOW);
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
        averageGradeRaw: s.gradesCount > 0 ? Number((s.gradesSum / s.gradesCount).toFixed(2)) : null,
        trend,
        trendDiff: trendDiff !== null ? Number(trendDiff.toFixed(2)) : null,
        trimesterAverages,
        trimesterRounded,
        marksByTrimester: [...s.marksByTrimester.entries()]
          .sort(sortTrimester)
          .map(([trimester, marks]) => ({
            trimester,
            marks: [...marks]
              .sort((a, b) => (a.ts - b.ts) || (a.slot - b.slot) || (a.seq - b.seq))
              .map((m) => ({ mark: m.mark, tooltip: m.tooltip }))
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
});
