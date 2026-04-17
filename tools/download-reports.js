const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');
require('dotenv').config();

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

function sanitizeFilePart(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9а-яА-ЯёЁ._-]/g, '')
    .slice(0, 80) || 'unknown-subject';
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

function buildApiHeaders(auth) {
  const headers = {
    Accept: '*/*',
    'Content-Type': 'application/json',
    'x-mes-subsystem': 'journalsw'
  };

  if (auth.profileId) headers['Profile-Id'] = String(auth.profileId);
  if (auth.roleId) headers['X-Mes-RoleId'] = String(auth.roleId);
  if (auth.hostId) headers['x-mes-hostid'] = String(auth.hostId);
  if (auth.aid) headers.aid = String(auth.aid);
  if (auth.bearerToken) headers.Authorization = `Bearer ${auth.bearerToken}`;
  return headers;
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

async function fetchPlanGroups(request, auth, opts, debug) {
  const headers = buildApiHeaders(auth);
  const all = [];
  let pageNum = 1;

  while (pageNum <= 10) {
    const qs = new URLSearchParams({
      page: String(pageNum),
      academic_year_id: String(opts.academicYearId),
      school_id: String(opts.schoolId),
      class_unit_ids: opts.classUnitIds.join(','),
      per_page: String(opts.perPage || 300)
    });
    const url = `https://school.mos.ru/api/ej/plan/teacher/v1/groups?${qs.toString()}`;
    if (debug) debug(`GET ${url}`);
    const res = await request.get(url, { headers });
    if (!res.ok()) {
      throw new Error(`Plan groups failed: ${res.status()} ${await res.text()}`);
    }
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) break;

    all.push(...data);
    if (data.length < (opts.perPage || 300)) break;
    pageNum += 1;
  }

  return all;
}

async function startApiExport(request, auth, payload, debug) {
  const headers = buildApiHeaders(auth);
  if (debug) debug(`POST export ${JSON.stringify(payload)}`);
  const res = await request.post('https://school.mos.ru/api/ej/report/teacher/v1/journals/export', {
    headers,
    data: payload
  });
  if (!res.ok()) {
    throw new Error(`Export start failed: ${res.status()} ${await res.text()}`);
  }
  return res.json();
}

async function pollApiExportStatus(request, auth, statusId, debug) {
  const headers = buildApiHeaders(auth);
  for (let i = 0; i < 50; i += 1) {
    const res = await request.get(
      `https://school.mos.ru/api/ej/report/teacher/v1/journals/export/status/${statusId}`,
      { headers }
    );
    if (!res.ok()) {
      throw new Error(`Export status failed: ${res.status()} ${await res.text()}`);
    }

    const data = await res.json();
    if (debug) debug(`status ${statusId} -> ${data.status}`);

    if (String(data.status).toLowerCase() === 'done') return data;
    if (String(data.status).toLowerCase() === 'error') {
      throw new Error(`Export status error for ${statusId}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 2500));
  }

  throw new Error(`Export status timeout for ${statusId}`);
}

async function downloadByUuid(request, auth, statusId, uuid, outputDir, groupMeta, debug) {
  const headers = buildApiHeaders(auth);
  const candidates = [
    `https://school.mos.ru/api/ej/report/teacher/v1/journals/export/download/${uuid}`,
    `https://school.mos.ru/api/ej/report/teacher/v1/journals/export/file/${uuid}`,
    `https://school.mos.ru/api/ej/report/teacher/v1/journals/export/status/${statusId}/download`,
    `https://school.mos.ru/api/ej/report/teacher/v1/journals/export/status/${statusId}`
  ];

  for (const url of candidates) {
    if (debug) debug(`download candidate: ${url}`);
    const res = await request.get(url, { headers });
    if (!res.ok()) continue;

    const ctype = (res.headers()['content-type'] || '').toLowerCase();
    const looksBinary =
      ctype.includes('spreadsheet') ||
      ctype.includes('octet-stream') ||
      ctype.includes('excel') ||
      ctype.includes('xlsx') ||
      ctype.includes('openxmlformats-officedocument') ||
      ctype.includes('ms-excel');
    if (!looksBinary) continue;

    const fileName = `group-${groupMeta.groupId}-${sanitizeFilePart(groupMeta.subject)}-${uuid}.xlsx`;
    const filePath = path.resolve(outputDir, fileName);
    fs.writeFileSync(filePath, await res.body());
    if (debug) debug(`saved: ${filePath}`);
    return filePath;
  }

  return null;
}

async function main() {
  const loginUrl = requiredEnv('MESH_LOGIN_URL');
  const mentorJournalsUrl = requiredEnv('MESH_MENTOR_JOURNALS_URL');

  const apiClassUnitIds = parseIdList(requiredEnv('API_CLASS_UNIT_IDS'));
  const apiSchoolId = requiredEnv('API_SCHOOL_ID');
  const apiAcademicYearId = requiredEnv('API_ACADEMIC_YEAR_ID');
  const exportStartAt = process.env.EXPORT_START_AT || '2025-09-01';
  const exportStopAt = process.env.EXPORT_STOP_AT || '2026-08-31';

  const apiRoleId = process.env.API_ROLE_ID || '9';
  const apiHostId = process.env.API_HOST_ID || '9';
  const apiAid = process.env.API_AID || '13';
  const apiGroupsPerPage = Number(process.env.API_GROUPS_PER_PAGE || '300');
  const apiIncludeMetagroups = String(process.env.API_INCLUDE_METAGROUPS || 'false').toLowerCase() === 'true';

  const headless = String(process.env.HEADLESS || 'false').toLowerCase() === 'true';
  const usePersistentProfile = String(process.env.USE_PERSISTENT_PROFILE || 'true').toLowerCase() === 'true';
  const browserProfileDir = path.resolve(process.env.BROWSER_PROFILE_DIR || 'output/browser-profile');
  const manualLogin = String(process.env.MANUAL_LOGIN || 'true').toLowerCase() === 'true';
  const debugApi = String(process.env.DEBUG_API || 'false').toLowerCase() === 'true';

  const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputDir = path.resolve('output', `downloads-${runStamp}`);
  fs.mkdirSync(outputDir, { recursive: true });

  const debug = (msg) => {
    if (debugApi) console.log(`[debug] ${msg}`);
  };

  let browser = null;
  let context = null;
  if (usePersistentProfile) {
    fs.mkdirSync(browserProfileDir, { recursive: true });
    context = await chromium.launchPersistentContext(browserProfileDir, { headless });
  } else {
    browser = await chromium.launch({ headless });
    context = await browser.newContext();
  }

  const page = await context.newPage();
  try {
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

    const profileId = process.env.API_PROFILE_ID || await getCookieValue(context, 'profile_id') || await getCookieValue(context, 'profileId');
    const bearerToken = process.env.API_BEARER_TOKEN || await getCookieValue(context, 'aupd_token');

    const auth = {
      profileId,
      roleId: apiRoleId,
      hostId: apiHostId,
      aid: apiAid,
      bearerToken
    };

    debug(`auth profileId=${profileId || 'none'} bearer=${bearerToken ? 'yes' : 'no'}`);

    console.log('[3/4] Load groups via API');
    const planGroups = await fetchPlanGroups(page.request, auth, {
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
        subject: norm(g.subject_name || '') || 'unknown-subject',
        name: norm(g.name || '')
      }))
      .filter((g) => Number.isFinite(g.groupId));

    console.log(`[4/4] Export groups: ${groups.length}`);

    const manifest = {
      generatedAt: new Date().toISOString(),
      outputDir,
      exportStartAt,
      exportStopAt,
      groups: []
    };

    for (const group of groups) {
      try {
        const startData = await startApiExport(page.request, auth, {
          group_ids: [group.groupId],
          start_at: exportStartAt,
          stop_at: exportStopAt
        }, debug);

        if (!startData?.status_id) continue;
        const statusData = await pollApiExportStatus(page.request, auth, startData.status_id, debug);
        if (!statusData?.uuid) continue;

        const filePath = await downloadByUuid(
          page.request,
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

    if (!okCount) {
      throw new Error('No files downloaded');
    }
  } finally {
    await context.close();
    if (browser) await browser.close();
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exitCode = 1;
});
