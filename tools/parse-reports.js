const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
require('dotenv').config();

function norm(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

function slugify(text) {
  return norm(text)
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '_')
    .replace(/^_+|_+$/g, '') || 'metric';
}

function parseMarkValue(value) {
  const s = norm(value);
  if (!s) return null;
  if (/^(см|нв)\.?$/i.test(s)) return null;
  if (/^н$/i.test(s)) return { type: 'absence', raw: s, num: null };
  const m = s.match(/^(\d+(?:[.,]\d+)?)([+-])?$/);
  if (!m) return { type: 'other', raw: s, num: null };
  let num = Number(m[1].replace(',', '.'));
  if (m[2] === '+') num += 0.25;
  if (m[2] === '-') num -= 0.25;
  return { type: 'grade', raw: s, num };
}

function splitMarks(rawValue) {
  const raw = norm(rawValue);
  if (!raw) return [];
  const chunks = raw
    .split(/[\n\r,;]+|\s{2,}/)
    .map((x) => norm(x))
    .filter(Boolean);
  if (!chunks.length) return [];
  if (chunks.every((x) => parseMarkValue(x))) return chunks;
  return [raw];
}

function extractSubject(sheetName) {
  let s = norm(sheetName);
  s = s.replace(/\s+[A-Za-zА-Яа-яЁё]{0,4}\d{4,}\s*$/u, '');
  s = s.replace(/^\s*\d+\S*\s+/u, '');
  s = s.replace(/^\s*\d+\s*пара\s+/giu, '');
  s = s.replace(/\b\d+\s*пара\b/giu, '');
  s = s.replace(/\d+\s*гр\.?\s*\d*/giu, '');
  s = s.replace(/гр\.?\s*\d+/giu, '');
  s = s.replace(/\s+\d+\s*гр\.?\s*\d*\s*$/giu, '');
  s = s.replace(/\s+гр\.?\s*\d+\s*$/giu, '');
  s = s.replace(/\s+гр\d+\s*$/giu, '');
  s = s.replace(/[A-Za-zА-Яа-яЁё]{2,}\d{5,}/gu, '');
  s = s.replace(/\b\d{5,}\b/g, '');
  s = s.replace(/\s+\d+\s*$/g, '');
  s = s.replace(/\s+гр\.?\s*$/giu, '');
  s = s.replace(/\s{2,}/g, ' ').trim();

  const aliases = [
    [/^рус(?:\.|ский)?\s*язык$/i, 'Русский язык'],
    [/^литература$/i, 'Литература'],
    [/^алгебра$/i, 'Алгебра'],
    [/^геометрия$/i, 'Геометрия'],
    [/^физ(?:\.|\s)*культура$/i, 'Физическая культура'],
    [/^физика$/i, 'Физика'],
    [/^информатика$/i, 'Информатика'],
    [/^биология$/i, 'Биология'],
    [/^география$/i, 'География'],
    [/^история$/i, 'История'],
    [/^труд\s*\(технология\)$/i, 'Труд (технология)'],
    [/^технология$/i, 'Труд (технология)'],
    [/^(англ\.?\s*язык|иностранный.*английск.*язык)$/i, 'Иностранный (английский) язык'],
    [/^(вероят\.?\s*и\s*стат\.?|вероятность.*статистик)/i, 'Вероятность и статистика']
  ];

  for (const [re, name] of aliases) {
    if (re.test(s)) return name;
  }

  const lower = s.toLowerCase();
  if (lower.includes('алгеб')) return 'Алгебра';
  if (lower.includes('геометр')) return 'Геометрия';
  if (lower.includes('вероят') || lower.includes('статист')) return 'Вероятность и статистика';
  if (lower.includes('информат')) return 'Информатика';
  if (lower.includes('технолог')) return 'Труд (технология)';
  if (lower.includes('биолог')) return 'Биология';
  if (lower.includes('географ')) return 'География';
  if (lower.includes('истор')) return 'История';
  if (lower.includes('литерат')) return 'Литература';
  if (lower.includes('рус') && lower.includes('язык')) return 'Русский язык';
  if (lower.includes('англ') || lower.includes('иностран')) return 'Иностранный (английский) язык';
  if (lower.includes('физ') && lower.includes('культур')) return 'Физическая культура';
  if (lower.includes('физик')) return 'Физика';

  return s || norm(sheetName) || 'unknown_subject';
}

function extractSubjectFromFileName(fileName) {
  const base = path.basename(String(fileName || ''), path.extname(String(fileName || '')));
  const m = base.match(/group-\d+-([^-]+(?:-[^-]+)*)-([0-9a-f]{32})$/i);
  if (!m) return '';
  return norm(String(m[1]).replace(/-/g, ' '));
}

function isSummaryColumn(dayValue) {
  const d = norm(dayValue).replace(/\s+/g, '');
  return /^[IVX\d]{1,4}[ТT]$/i.test(d) || /^(год|итог|ср|сб)/i.test(d);
}

function detectGradeBounds(rows, header0, header1) {
  const studentIdx = header0.findIndex((h) => /^обучающ/i.test(h));
  const start = studentIdx >= 0 ? studentIdx + 1 : 2;
  let end = Math.max(start, header0.length - 1);

  let dateIdx = header0.findIndex((h) => /^дата$/i.test(h));
  if (dateIdx < 0) dateIdx = header0.findIndex((h) => /дата/i.test(h));
  if (dateIdx > start) end = Math.min(end, dateIdx - 1);

  let maxUsed = start;
  const rowLimit = Math.min(rows.length, 300);
  for (let r = 1; r < rowLimit; r += 1) {
    const row = rows[r] || [];
    const rank = norm(row[0]);
    if (!/^\d+$/.test(rank)) continue;
    for (let c = start; c <= end; c += 1) {
      const v = norm(row[c]);
      if (!v) continue;
      if (splitMarks(v).some((m) => !!parseMarkValue(m))) {
        maxUsed = Math.max(maxUsed, c);
      }
    }
  }

  return { gradeStart: start, gradeEnd: Math.max(start, maxUsed) };
}

function isBlockHeaderRow(row) {
  const c0 = norm(row?.[0]);
  const c1 = norm(row?.[1]).toLowerCase();
  return c0 === '№' && /обучающ/.test(c1);
}

function findHeaderBlocks(rows) {
  const starts = [];
  for (let i = 0; i < rows.length - 1; i += 1) {
    if (!isBlockHeaderRow(rows[i])) continue;
    const next = (rows[i + 1] || []).map(norm);
    const hasDateLike = next.slice(2).some((v) => /(\d{1,2}|[ivx]{1,3}\s*т|[123]\s*т)/i.test(v));
    if (hasDateLike) starts.push(i);
  }
  if (!starts.length && rows.length >= 2) starts.push(0);
  return starts;
}

function normalizeMonthToken(raw, activeMonth) {
  const token = norm(raw).toLowerCase().replace(/[.]/g, '');
  if (!token) return activeMonth || '';

  const monthMap = {
    'янв': 'янв',
    'ян': 'янв',
    'я': 'янв',
    'фев': 'фев',
    'ф': 'фев',
    'мар': 'мар',
    'март': 'мар',
    'м': 'мар',
    'апр': 'апр',
    'ап': 'апр',
    'а': 'апр',
    'май': 'май',
    'мая': 'май',
    'июн': 'июн',
    'июл': 'июл',
    'авг': 'авг',
    'сен': 'сен',
    'сент': 'сен',
    'с': 'сен',
    'окт': 'окт',
    'о': 'окт',
    'ноя': 'ноя',
    'нояб': 'ноя',
    'н': 'ноя',
    'дек': 'дек',
    'д': 'дек'
  };

  if (monthMap[token]) return monthMap[token];
  if (/^[а-яё]{3,}$/.test(token)) return token.slice(0, 3);
  return activeMonth || '';
}

function parseWorkbook(filePath) {
  const workbook = XLSX.readFile(filePath, { cellDates: false });
  const sourceFile = path.basename(filePath);
  const forcedSubject = extractSubjectFromFileName(sourceFile);
  const rowsOut = [];

  for (const sheetName of workbook.SheetNames) {
    const ws = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
    if (!rows.length) continue;
    const subject = forcedSubject || extractSubject(sheetName);
    const blockStarts = findHeaderBlocks(rows);

    for (let b = 0; b < blockStarts.length; b += 1) {
      const start = blockStarts[b];
      const end = b + 1 < blockStarts.length ? blockStarts[b + 1] : rows.length;
      const blockRows = rows.slice(start, end);
      if (blockRows.length < 3) continue;

      const header0 = (blockRows[0] || []).map(norm);
      const header1 = (blockRows[1] || []).map(norm);
      const studentIdx = header0.findIndex((h) => /^обучающ/i.test(h)) >= 0
        ? header0.findIndex((h) => /^обучающ/i.test(h))
        : 1;
      const { gradeStart, gradeEnd } = detectGradeBounds(blockRows, header0, header1);
      if (gradeEnd < gradeStart) continue;

      const colMeta = {};
      let activeMonth = '';
      const slotCounter = new Map();
      for (let c = gradeStart; c <= gradeEnd; c += 1) {
        const d = norm(header1[c]);
        if (isSummaryColumn(d)) continue;
        const m = normalizeMonthToken(header0[c], activeMonth);
        if (m) activeMonth = m;
        const month = activeMonth;
        const day = d;
        const key = `${month}|${day}`;
        const slot = (slotCounter.get(key) || 0) + 1;
        slotCounter.set(key, slot);
        const periodBase = [month, day].filter(Boolean).join(' ').trim();
        const period = periodBase ? (slot > 1 ? `${periodBase} #${slot}` : periodBase) : `Колонка ${c + 1}`;
        colMeta[c] = { month, day, slot, period };
      }

      for (let r = 2; r < blockRows.length; r += 1) {
        const row = (blockRows[r] || []).map(norm);
        const rank = row[0];
        const student = row[studentIdx];
        if (!/^\d+$/.test(rank) || !student) continue;

        for (let c = gradeStart; c <= gradeEnd; c += 1) {
          const cellValue = norm(row[c]);
          if (!cellValue) continue;
          const marks = splitMarks(cellValue);
          if (!marks.length) continue;
          const meta = colMeta[c];
          if (!meta) continue;

          for (const markRaw of marks) {
            const parsed = parseMarkValue(markRaw);
            if (!parsed) continue;
            rowsOut.push({
              student,
              subject,
              month: meta.month,
              day: meta.day,
              slot: meta.slot,
              period: meta.period,
              mark: parsed.raw,
              markType: parsed.type,
              numericMark: Number.isFinite(parsed.num) ? parsed.num : null,
              weight: 1,
              sourceSheet: sheetName,
              sourceFile,
              columnIndex: c
            });
          }
        }
      }
    }
  }

  return rowsOut;
}

function latestDownloadsDir(rootDir) {
  if (!fs.existsSync(rootDir)) return null;
  const dirs = fs.readdirSync(rootDir)
    .filter((name) => name.startsWith('downloads-'))
    .map((name) => path.join(rootDir, name))
    .filter((full) => fs.statSync(full).isDirectory())
    .sort();
  return dirs.at(-1) || null;
}

function toCsv(rows) {
  const header = [
    'student',
    'subject',
    'month',
    'day',
    'slot',
    'period',
    'mark',
    'markType',
    'numericMark',
    'weight',
    'sourceSheet',
    'sourceFile'
  ];
  const escapeCell = (v) => {
    const s = String(v ?? '');
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [header.join(',')];
  for (const row of rows) {
    const values = header.map((k) => row[k] ?? '');
    lines.push(values.map(escapeCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

function buildByStudent(rows) {
  const byStudent = new Map();
  for (const row of rows) {
    if (!byStudent.has(row.student)) byStudent.set(row.student, []);
    byStudent.get(row.student).push(row);
  }

  for (const marks of byStudent.values()) {
    const dedup = new Map();
    for (const m of marks) {
      const key = [
        m.student,
        m.subject,
        m.period,
        m.mark,
        m.sourceSheet,
        m.sourceFile,
        m.columnIndex
      ].join('|');
      if (!dedup.has(key)) dedup.set(key, m);
    }
    marks.length = 0;
    marks.push(...dedup.values());
    marks.sort((a, b) =>
      a.subject.localeCompare(b.subject, 'ru') ||
      a.sourceSheet.localeCompare(b.sourceSheet, 'ru') ||
      a.columnIndex - b.columnIndex
    );
  }

  return byStudent;
}

function main() {
  const outputDir = path.resolve(process.env.OUTPUT_DIR || 'output');
  const reportsDir = process.env.REPORTS_DIR
    ? path.resolve(process.env.REPORTS_DIR)
    : latestDownloadsDir(outputDir);

  if (!reportsDir) {
    throw new Error('Не найдена папка с отчетами. Укажите REPORTS_DIR=...');
  }

  const files = fs.readdirSync(reportsDir)
    .filter((f) => f.toLowerCase().endsWith('.xlsx'))
    .map((f) => path.join(reportsDir, f))
    .sort();

  if (!files.length) {
    throw new Error(`В папке нет XLSX: ${reportsDir}`);
  }

  const parsedRows = [];
  for (const file of files) {
    parsedRows.push(...parseWorkbook(file));
  }

  const byStudentMap = buildByStudent(parsedRows);
  const students = [...byStudentMap.keys()].sort((a, b) => a.localeCompare(b, 'ru'));
  const byStudent = Object.fromEntries(byStudentMap.entries());

  const generatedAt = new Date().toISOString();
  const stamp = generatedAt.replace(/[:.]/g, '-');
  const jsonPath = path.join(outputDir, `analytics-${stamp}.json`);
  const csvPath = path.join(outputDir, `analytics-${stamp}.csv`);
  const latestJsonPath = path.join(outputDir, 'analytics-latest.json');
  const latestCsvPath = path.join(outputDir, 'analytics-latest.csv');

  const payload = {
    generatedAt,
    reportsDir,
    filesCount: files.length,
    rowsCount: parsedRows.length,
    students,
    byStudent,
    subjectsCount: new Set(parsedRows.map((r) => r.subject)).size
  };

  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  fs.writeFileSync(latestJsonPath, JSON.stringify(payload, null, 2));

  const csv = toCsv(parsedRows);
  fs.writeFileSync(csvPath, csv);
  fs.writeFileSync(latestCsvPath, csv);

  const subjectStats = {};
  for (const row of parsedRows) {
    const k = row.subject || 'unknown_subject';
    subjectStats[k] = (subjectStats[k] || 0) + 1;
  }

  console.log(`[parse] Reports dir: ${reportsDir}`);
  console.log(`[parse] Files: ${files.length}`);
  console.log(`[parse] Rows: ${parsedRows.length}`);
  console.log(`[parse] Students: ${students.length}`);
  console.log(`[parse] Subjects: ${Object.keys(subjectStats).length}`);
  console.log(`[parse] JSON: ${jsonPath}`);
  console.log(`[parse] CSV:  ${csvPath}`);
}

try {
  main();
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
}
