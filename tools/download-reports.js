const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium, request: playwrightRequest } = require('playwright');
const {
  fetchPlanGroups,
  fetchStudentProfiles,
  fetchMarksByGroup,
  fetchAttendancesByGroup,
  fetchAttestationPeriodsSchedule,
  startApiExport,
  pollApiExportStatus,
  downloadByUuid
} = require('./mesh-api');
require('dotenv').config();

const MONTH_SHORT_RU = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MARKING_GROUPS_LATEST_PATH = path.resolve('output', 'marking-groups-latest.json');

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function norm(v) {
  return String(v ?? '').replace(/\s+/g, ' ').trim();
}

function parseIdList(raw) {
  return String(raw || '')
    .split(',')
    .map((x) => Number(x.trim()))
    .filter((n) => Number.isFinite(n));
}

function askEnter(promptText) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question(promptText, () => {
      rl.close();
      resolve();
    });
  });
}

function isLoginLikeUrl(url) {
  return /login\.mos\.ru|\/sps\/login|oauth|auth/i.test(String(url || ''));
}

async function getCookieValue(context, name) {
  const cookies = await context.cookies();
  const hit = cookies.find((c) => c.name === name);
  return hit ? hit.value : '';
}

async function hasAuthenticatedSession(page, journalUrl) {
  if (!journalUrl) return false;
  try {
    await page.goto(journalUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
    return !isLoginLikeUrl(page.url());
  } catch (_) {
    return false;
  }
}

async function ensureAuthenticatedByJournal(page, journalUrl, maxAttempts = 5) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await page.goto(journalUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const current = page.url();
    if (!isLoginLikeUrl(current)) return;

    if (attempt < maxAttempts) {
      console.log(`Still not authenticated: ${current}`);
      console.log('Finish login/2FA in browser and press Enter.');
      await askEnter(`Press Enter to retry (${attempt + 1}/${maxAttempts})...`);
    }
  }

  throw new Error(`Authentication was not completed. Current URL: ${page.url()}`);
}

function isoToRuDate(value) {
  const raw = norm(value);
  if (!raw) return '';
  if (/^\d{2}\.\d{2}\.\d{4}$/.test(raw)) return raw;

  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return raw;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

function parseRuDate(dateStr) {
  const m = String(dateStr || '').match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yyyy = Number(m[3]);
  if (!Number.isFinite(dd) || !Number.isFinite(mm) || !Number.isFinite(yyyy)) return null;
  return { dd, mm, yyyy };
}

function parseMarkValue(raw, values) {
  const s = norm(raw);
  if (!s) return null;
  if (/^(см|нв)\.?$/i.test(s)) return null;
  if (/^н$/i.test(s)) return { mark: 'н', markType: 'absence', numericMark: null };

  const m = s.match(/^(\d+(?:[.,]\d+)?)([+-])?$/);
  if (m) {
    let num = Number(m[1].replace(',', '.'));
    if (m[2] === '+') num += 0.25;
    if (m[2] === '-') num -= 0.25;
    return { mark: s, markType: 'grade', numericMark: Number.isFinite(num) ? num : null };
  }

  const ten = Number(values?.[0]?.grade?.ten);
  if (Number.isFinite(ten)) {
    return { mark: s, markType: 'grade', numericMark: ten };
  }
  return { mark: s, markType: 'other', numericMark: null };
}

function asNumber(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && !v.trim()) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function parseFinalMarkValue(finalMark) {
  if (Boolean(finalMark?.academic_debt)) return 2;
  const value = asNumber(finalMark?.value);
  const manualValue = asNumber(finalMark?.manual_value);
  const picked = manualValue ?? value;
  if (!Number.isFinite(picked)) return null;
  if (picked <= 0) return null;
  if (picked > 100) return null;
  return picked;
}

function pickStudentName(profile) {
  const fio = [profile.last_name, profile.first_name, profile.middle_name].map(norm).filter(Boolean).join(' ');
  if (fio) return fio;
  return norm(profile.short_name || profile.user_name || `ID ${profile.id}`);
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
  return byStudent;
}

function buildMarkingGroupsSnapshot(groups) {
  return groups
    .filter((g) => Number.isFinite(Number(g.groupId)))
    .map((g) => ({
      id: Number(g.groupId),
      name: norm(g.name || ''),
      subjectName: norm(g.subject || ''),
      classUnitName: '',
      studentCount: null,
      subjectId: Number.isFinite(Number(g.subjectId)) ? Number(g.subjectId) : null,
      classLevelId: Number.isFinite(Number(g.classLevelId)) ? Number(g.classLevelId) : null,
      canMark: true
    }));
}

function cleanupHistoricalArtifacts(outputRoot) {
  if (!fs.existsSync(outputRoot)) return;
  const entries = fs.readdirSync(outputRoot, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(outputRoot, e.name);
    if (e.isDirectory()) {
      if (e.name.startsWith('downloads-') && e.name !== 'downloads-latest') {
        fs.rmSync(full, { recursive: true, force: true });
      }
      continue;
    }
    if (e.isFile()) {
      if (/^analytics-.*\.(json|csv)$/i.test(e.name) && !/^analytics-latest\.(json|csv)$/i.test(e.name)) {
        fs.rmSync(full, { force: true });
      }
    }
  }
}

async function runLegacyExportMode(requestApi, auth, groups, opts, debug, outputDir) {
  console.log(`[4/4] Export groups (legacy XLSX): ${groups.length}`);
  const manifest = {
    generatedAt: new Date().toISOString(),
    outputDir,
    exportStartAt: opts.exportStartAt,
    exportStopAt: opts.exportStopAt,
    mode: 'api_export_legacy',
    groups: []
  };

  for (const group of groups) {
    try {
      const startData = await startApiExport(requestApi, auth, {
        group_ids: [group.groupId],
        start_at: opts.exportStartAt,
        stop_at: opts.exportStopAt
      }, debug);
      if (!startData?.status_id) continue;
      const statusData = await pollApiExportStatus(requestApi, auth, startData.status_id, debug);
      if (!statusData?.uuid) continue;

      const filePath = await downloadByUuid(
        requestApi,
        auth,
        startData.status_id,
        statusData.uuid,
        outputDir,
        group,
        debug
      );

      manifest.groups.push({
        groupId: group.groupId,
        subject: group.subject,
        groupName: group.name,
        statusId: startData.status_id,
        uuid: statusData.uuid,
        filePath: filePath || null
      });
    } catch (err) {
      console.warn(`Export failed for group ${group.groupId}: ${err.message}`);
    }
  }

  const okCount = manifest.groups.filter((g) => g.filePath).length;
  const manifestPath = path.join(outputDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`Downloaded files: ${okCount}`);
  console.log(`Reports dir: ${outputDir}`);
  console.log(`Manifest: ${manifestPath}`);
  if (!okCount) throw new Error('No files downloaded');
}

async function runApiMarksMode(requestApi, auth, groups, opts, debug, outputDir) {
  console.log(`[4/4] API marks sync for groups: ${groups.length}`);
  const fromRu = isoToRuDate(opts.exportStartAt);
  const toRu = isoToRuDate(opts.exportStopAt);

  const profiles = await fetchStudentProfiles(requestApi, auth, {
    academicYearId: opts.apiAcademicYearId,
    classUnitIds: opts.apiClassUnitIds,
    perPage: opts.apiProfilesPerPage
  }, debug);

  const studentNameById = new Map();
  for (const p of profiles) {
    const id = Number(p.id);
    if (!Number.isFinite(id)) continue;
    studentNameById.set(id, pickStudentName(p));
  }

  const scheduleIds = [...new Set(groups
    .map((g) => Number(g.attestationPeriodsScheduleId))
    .filter((x) => Number.isFinite(x) && x > 0))];
  const periodLabelById = new Map();
  for (const sid of scheduleIds) {
    try {
      const schedule = await fetchAttestationPeriodsSchedule(requestApi, auth, sid, debug);
      const periods = Array.isArray(schedule?.periods) ? schedule.periods : [];
      for (const p of periods) {
        const pid = Number(p.id);
        if (!Number.isFinite(pid)) continue;
        periodLabelById.set(pid, norm(p.name || ''));
      }
    } catch (err) {
      console.warn(`Attestation schedule failed (${sid}): ${err.message}`);
    }
  }

  const rows = [];
  const marksManifest = [];
  for (const group of groups) {
    try {
      const marks = await fetchMarksByGroup(
        requestApi,
        auth,
        group,
        fromRu,
        toRu,
        opts.apiMarksPerPage,
        debug
      );
      marksManifest.push({ groupId: group.groupId, subject: group.subject, count: marks.length });

      for (const item of marks) {
        const studentProfileId = Number(item.student_profile_id);
        const student = studentNameById.get(studentProfileId) || `ID ${studentProfileId}`;
        const markParsed = parseMarkValue(item.name || item.values?.[0]?.grade?.origin, item.values);
        if (!markParsed) continue;

        const date = isoToRuDate(item.date);
        const parsedDate = parseRuDate(date);
        const month = parsedDate ? MONTH_SHORT_RU[parsedDate.mm - 1] : '';
        const day = parsedDate ? String(parsedDate.dd) : '';

        rows.push({
          student,
          subject: group.subject,
          month,
          day,
          slot: null,
          period: date || '',
          mark: markParsed.mark,
          markType: markParsed.markType,
          numericMark: Number.isFinite(markParsed.numericMark) ? markParsed.numericMark : null,
          sourceSheet: 'api',
          sourceFile: 'api',
          groupId: Number(group.groupId),
          studentProfileId: Number.isFinite(studentProfileId) ? studentProfileId : null,
          subjectId: Number(group.subjectId),
          scheduleLessonId: Number(item.schedule_lesson_id) || null,
          markId: Number(item.id) || null,
          weight: Number.isFinite(Number(item.weight)) && Number(item.weight) > 0 ? Number(item.weight) : 1,
          date
        });
      }

      if (opts.apiIncludeAttendances) {
        const attendances = await fetchAttendancesByGroup(
          requestApi,
          auth,
          group,
          opts.apiAcademicYearId,
          fromRu,
          toRu,
          opts.apiAttendancesPerPage,
          debug
        );

        const seenAbsence = new Set(
          rows
            .filter((r) => r.markType === 'absence' && Number(r.groupId) === Number(group.groupId))
            .map((r) => `${r.studentProfileId}|${r.scheduleLessonId}|${r.groupId}`)
        );

        for (const a of attendances) {
          const studentProfileId = Number(a.student_profile_id);
          if (!Number.isFinite(studentProfileId)) continue;
          const scheduleLessonId = Number(a.schedule_lesson_id) || null;
          const dedupeKey = `${studentProfileId}|${scheduleLessonId}|${group.groupId}`;
          if (seenAbsence.has(dedupeKey)) continue;
          seenAbsence.add(dedupeKey);

          const student = studentNameById.get(studentProfileId) || `ID ${studentProfileId}`;
          const date = isoToRuDate(a.date);
          const parsedDate = parseRuDate(date);
          const month = parsedDate ? MONTH_SHORT_RU[parsedDate.mm - 1] : '';
          const day = parsedDate ? String(parsedDate.dd) : '';

          rows.push({
            student,
            subject: group.subject,
            month,
            day,
            slot: null,
            period: date || '',
            mark: 'н',
            markType: 'absence',
            numericMark: null,
            sourceSheet: 'api',
            sourceFile: 'api',
            groupId: Number(group.groupId),
            studentProfileId,
            subjectId: Number(group.subjectId),
            scheduleLessonId,
            markId: null,
            weight: 1,
            date
          });
        }
      }
    } catch (err) {
      console.warn(`Marks sync failed for group ${group.groupId}: ${err.message}`);
    }
  }

  for (const profile of profiles) {
    const studentProfileId = Number(profile.id);
    if (!Number.isFinite(studentProfileId)) continue;
    const student = studentNameById.get(studentProfileId) || `ID ${studentProfileId}`;
    const finalMarks = Array.isArray(profile.final_marks) ? profile.final_marks : [];

    for (const fm of finalMarks) {
      const isYear = Boolean(fm.is_year_mark || fm.year_mark);
      if (isYear) continue;
      if (Boolean(fm.no_mark)) continue;

      const subjectId = Number(fm.subject_id);
      const periodId = Number(fm.attestation_period_id || fm.period_id);
      const numeric = parseFinalMarkValue(fm);
      if (!Number.isFinite(subjectId) || !Number.isFinite(periodId) || !Number.isFinite(numeric)) continue;

      const groupForSubject = groups.find((g) => g.subjectId === subjectId);
      const subject = groupForSubject ? groupForSubject.subject : `subject_${subjectId}`;
      const trimesterLabel = periodLabelById.get(periodId) || '';
      if (!trimesterLabel) continue;

      rows.push({
        student,
        subject,
        month: '',
        day: '',
        slot: null,
        period: trimesterLabel,
        mark: String(Math.round(numeric)),
        markType: 'final_trimester',
        numericMark: Number(numeric),
        sourceSheet: 'api',
        sourceFile: 'api',
        groupId: groupForSubject ? Number(groupForSubject.groupId) : null,
        studentProfileId,
        subjectId,
        scheduleLessonId: null,
        markId: Number(fm.id) || null,
        weight: 1,
        date: '',
        trimesterLabel
      });
    }
  }

  rows.sort((a, b) => {
    if (a.student !== b.student) return a.student.localeCompare(b.student, 'ru');
    if (a.subject !== b.subject) return a.subject.localeCompare(b.subject, 'ru');
    const ad = parseRuDate(a.date);
    const bd = parseRuDate(b.date);
    const ats = ad ? Date.UTC(ad.yyyy, ad.mm - 1, ad.dd) : 0;
    const bts = bd ? Date.UTC(bd.yyyy, bd.mm - 1, bd.dd) : 0;
    return ats - bts;
  });

  const byStudentMap = buildByStudent(rows);
  const students = [...byStudentMap.keys()].sort((a, b) => a.localeCompare(b, 'ru'));
  const byStudent = {};
  for (const name of students) byStudent[name] = byStudentMap.get(name);

  const analyticsPayload = {
    generatedAt: new Date().toISOString(),
    mode: 'api_marks',
    reportsDir: outputDir,
    filesCount: groups.length,
    rowsCount: rows.length,
    students,
    byStudent
  };

  const analyticsPath = path.join('output', 'analytics-latest.json');
  const analyticsLatestPath = path.join('output', 'analytics-latest.json');
  const csvPath = path.join('output', 'analytics-latest.csv');
  const marksManifestPath = path.join(outputDir, 'marks-manifest.json');

  fs.writeFileSync(marksManifestPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    mode: 'api_marks',
    groups: marksManifest
  }, null, 2));
  fs.writeFileSync(analyticsPath, JSON.stringify(analyticsPayload, null, 2));
  if (analyticsLatestPath !== analyticsPath) {
    fs.writeFileSync(analyticsLatestPath, JSON.stringify(analyticsPayload, null, 2));
  }
  fs.writeFileSync(csvPath, toCsv(rows));

  console.log(`Rows collected: ${rows.length}`);
  console.log(`Students: ${students.length}`);
  console.log(`Analytics JSON: ${analyticsPath}`);
  console.log(`Analytics CSV: ${csvPath}`);
  console.log(`Marks manifest: ${marksManifestPath}`);

  if (!rows.length) {
    throw new Error('No marks collected from API');
  }
}

async function main() {
  const loginUrl = requiredEnv('MESH_LOGIN_URL');
  const mentorJournalsUrl = requiredEnv('MESH_MENTOR_JOURNALS_URL');

  const apiClassUnitIds = parseIdList(requiredEnv('API_CLASS_UNIT_IDS'));
  const apiSchoolId = requiredEnv('API_SCHOOL_ID');
  const apiAcademicYearId = requiredEnv('API_ACADEMIC_YEAR_ID');
  const exportStartAt = process.env.EXPORT_START_AT || '2025-09-01';
  const exportStopAt = process.env.EXPORT_STOP_AT || '2026-08-31';
  const downloadMode = String(process.env.DOWNLOAD_MODE || 'api_marks').toLowerCase();

  const apiRoleId = process.env.API_ROLE_ID || '9';
  const apiHostId = process.env.API_HOST_ID || '9';
  const apiAid = process.env.API_AID || '13';
  const apiGroupsPerPage = Number(process.env.API_GROUPS_PER_PAGE || '300');
  const apiProfilesPerPage = Number(process.env.API_PROFILES_PER_PAGE || '300');
  const apiMarksPerPage = Number(process.env.API_MARKS_PER_PAGE || '300');
  const apiAttendancesPerPage = Number(process.env.API_ATTENDANCES_PER_PAGE || '1000');
  const apiIncludeAttendances = String(process.env.API_INCLUDE_ATTENDANCES ?? 'true').toLowerCase() === 'true';
  const apiIncludeMetagroups = String(process.env.API_INCLUDE_METAGROUPS || 'false').toLowerCase() === 'true';

  const headless = String(process.env.HEADLESS || 'false').toLowerCase() === 'true';
  const usePersistentProfile = String(process.env.USE_PERSISTENT_PROFILE || 'true').toLowerCase() === 'true';
  const browserProfileDir = path.resolve(process.env.BROWSER_PROFILE_DIR || 'output/browser-profile');
  const manualLogin = String(process.env.MANUAL_LOGIN || 'true').toLowerCase() === 'true';
  const debugApi = String(process.env.DEBUG_API || 'false').toLowerCase() === 'true';
  const syncNoBrowserAuth = String(process.env.SYNC_NO_BROWSER_AUTH || 'false').toLowerCase() === 'true';

  const outputRoot = path.resolve('output');
  cleanupHistoricalArtifacts(outputRoot);
  const outputDir = path.resolve(outputRoot, 'downloads-latest');
  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });

  const debug = (msg) => {
    if (debugApi) console.log(`[debug] ${msg}`);
  };

  let browser = null;
  let context = null;
  let page = null;
  let requestApi = null;
  try {
    let profileId = process.env.API_PROFILE_ID || '';
    let bearerToken = process.env.API_BEARER_TOKEN || '';

    if (syncNoBrowserAuth) {
      console.log('[1/4] Direct API auth mode (no browser launch)');
      if (!profileId || !bearerToken) {
        throw new Error('SYNC_NO_BROWSER_AUTH=true requires API_PROFILE_ID and API_BEARER_TOKEN');
      }
      requestApi = await playwrightRequest.newContext();
    } else {
      if (usePersistentProfile) {
        fs.mkdirSync(browserProfileDir, { recursive: true });
        context = await chromium.launchPersistentContext(browserProfileDir, { headless });
      } else {
        browser = await chromium.launch({ headless });
        context = await browser.newContext();
      }
      page = await context.newPage();
      requestApi = page.request;

      console.log(`[1/4] Open login page: ${loginUrl}`);
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });

      if (manualLogin) {
        const active = await hasAuthenticatedSession(page, mentorJournalsUrl);
        if (active) {
          console.log('[2/4] Active session detected');
        } else {
          console.log('[2/4] Manual login mode');
          console.log('Log in to MESH in the browser, then press Enter.');
          await askEnter('Press Enter after login... ');
        }
      }

      await ensureAuthenticatedByJournal(page, mentorJournalsUrl);

      profileId = profileId ||
        await getCookieValue(context, 'profile_id') ||
        await getCookieValue(context, 'profileId');
      bearerToken = bearerToken || await getCookieValue(context, 'aupd_token');
    }

    const auth = {
      profileId,
      roleId: apiRoleId,
      hostId: apiHostId,
      aid: apiAid,
      bearerToken
    };

    debug(`mode=${downloadMode} profileId=${profileId || 'none'} bearer=${bearerToken ? 'yes' : 'no'}`);

    console.log('[3/4] Load groups via API');
    const planGroups = await fetchPlanGroups(requestApi, auth, {
      academicYearId: apiAcademicYearId,
      schoolId: apiSchoolId,
      classUnitIds: apiClassUnitIds,
      perPage: apiGroupsPerPage
    }, debug);

    const groups = planGroups
      .filter((g) => Number(g.student_count || 0) > 0)
      .filter((g) => apiIncludeMetagroups || !g.is_metagroup)
      .map((g) => ({
        groupId: Number(g.id),
        subjectId: Number(g.subject_id),
        classLevelId: Number(g.class_level_id),
        attestationPeriodsScheduleId: Number(g.attestation_periods_schedule_id),
        subject: norm(g.subject_name || '') || 'unknown-subject',
        name: norm(g.name || '')
      }))
      .filter((g) => Number.isFinite(g.groupId) && Number.isFinite(g.subjectId));

    const groupsSnapshot = {
      generatedAt: new Date().toISOString(),
      source: 'download-reports',
      groups: buildMarkingGroupsSnapshot(groups)
    };
    fs.writeFileSync(MARKING_GROUPS_LATEST_PATH, JSON.stringify(groupsSnapshot, null, 2));
    console.log(`Marking groups snapshot: ${MARKING_GROUPS_LATEST_PATH}`);

    if (downloadMode === 'api_export' || downloadMode === 'legacy_xlsx') {
      await runLegacyExportMode(requestApi, auth, groups, { exportStartAt, exportStopAt }, debug, outputDir);
    } else {
      await runApiMarksMode(requestApi, auth, groups, {
        exportStartAt,
        exportStopAt,
        apiAcademicYearId,
        apiClassUnitIds,
        apiProfilesPerPage,
        apiMarksPerPage,
        apiAttendancesPerPage,
        apiIncludeAttendances
      }, debug, outputDir);
    }
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
    if (requestApi && syncNoBrowserAuth) {
      await requestApi.dispose();
    }
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
});
