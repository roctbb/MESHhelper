const fs = require('fs');
const path = require('path');
const http = require('http');
require('dotenv').config();

const ROOT = __dirname;
const WEB_DIR = path.join(ROOT, 'web');
const PORT = Number(process.env.WEB_PORT || 8787);
const MESH_BASE = 'https://school.mos.ru';

const TRIMESTERS = [
  {
    key: 't1',
    label: process.env.TRIMESTER_1_LABEL || '1 триместр',
    start: process.env.TRIMESTER_1_START || '2025-09-01',
    end: process.env.TRIMESTER_1_END || '2025-11-30'
  },
  {
    key: 't2',
    label: process.env.TRIMESTER_2_LABEL || '2 триместр',
    start: process.env.TRIMESTER_2_START || '2025-12-01',
    end: process.env.TRIMESTER_2_END || '2026-02-28'
  },
  {
    key: 't3',
    label: process.env.TRIMESTER_3_LABEL || '3 триместр',
    start: process.env.TRIMESTER_3_START || '2026-03-01',
    end: process.env.TRIMESTER_3_END || '2026-05-23'
  }
];

function parseIdList(raw) {
  return String(raw || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n));
}

function json(res, status, data) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
      if (body.length > 5 * 1024 * 1024) {
        reject(new Error('Request body too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (_) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sanitizePath(rawPath) {
  const p = String(rawPath || '').trim();
  if (!p.startsWith('/api/')) return null;
  if (p.includes('..')) return null;
  return p;
}

function normalizeSubsystem(rawSubsystem) {
  const value = String(rawSubsystem || '').trim().toLowerCase();
  if (!value) return 'journalw';
  // В старом коде была опечатка `journalsw`, из-за которой control_forms возвращал [].
  if (value === 'journalsw') return 'journalw';
  return value;
}

function buildProxyHeaders(auth, subsystem) {
  const token = String(auth?.token || '').trim();
  const profileId = String(auth?.profileId || '').trim();
  const roleId = String(auth?.roleId || process.env.API_ROLE_ID || '9').trim();
  const hostId = String(auth?.hostId || process.env.API_HOST_ID || '9').trim();
  const aid = String(auth?.aid || process.env.API_AID || '13').trim();

  if (!token || !profileId) {
    throw new Error('token/profile_id are required');
  }

  return {
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'Profile-Id': profileId,
    'X-Mes-RoleId': roleId,
    'x-mes-hostid': hostId,
    aid,
    'x-mes-subsystem': normalizeSubsystem(subsystem || process.env.API_SUBSYSTEM || 'journalw')
  };
}

async function proxyMesh(payload) {
  const method = String(payload?.method || 'GET').toUpperCase();
  const apiPath = sanitizePath(payload?.path);
  const query = payload?.query && typeof payload.query === 'object' ? payload.query : {};
  const body = payload?.body ?? null;

  if (!apiPath) throw new Error('Invalid API path');

  const url = new URL(MESH_BASE + apiPath);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }

  const headers = buildProxyHeaders(payload?.auth || {}, payload?.subsystem);
  const reqInit = {
    method,
    headers
  };
  if (method !== 'GET' && method !== 'HEAD') {
    reqInit.body = JSON.stringify(body || {});
  }

  const response = await fetch(url, reqInit);
  const ctype = response.headers.get('content-type') || '';
  let data;
  if (ctype.includes('application/json')) {
    data = await response.json().catch(() => ({}));
  } else {
    data = await response.text();
  }

  return {
    ok: response.ok,
    status: response.status,
    contentType: ctype,
    data
  };
}

function serveStatic(req, res) {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = filePath.split('?')[0];
  const abs = path.resolve(WEB_DIR, `.${filePath}`);
  if (!abs.startsWith(WEB_DIR)) {
    res.statusCode = 403;
    return res.end('Forbidden');
  }
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    res.statusCode = 404;
    return res.end('Not found');
  }

  const ext = path.extname(abs).toLowerCase();
  const ctype =
    ext === '.html' ? 'text/html; charset=utf-8'
      : ext === '.js' ? 'application/javascript; charset=utf-8'
        : ext === '.css' ? 'text/css; charset=utf-8'
          : ext === '.json' ? 'application/json; charset=utf-8'
            : 'application/octet-stream';

  res.statusCode = 200;
  res.setHeader('Content-Type', ctype);
  fs.createReadStream(abs).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/api/config') {
      return json(res, 200, {
        appName: 'MESH Assistant',
        meshBase: MESH_BASE,
        academicYearId: Number(process.env.API_ACADEMIC_YEAR_ID || 13),
        schoolId: Number(process.env.API_SCHOOL_ID || 0),
        analyticsClassUnitIds: parseIdList(process.env.API_CLASS_UNIT_IDS),
        groupsPerPage: Number(process.env.API_GROUPS_PER_PAGE || 300),
        marksPerPage: Number(process.env.API_MARKS_PER_PAGE || 300),
        attendancesPerPage: Number(process.env.API_ATTENDANCES_PER_PAGE || 1000),
        includeAttendances: String(process.env.API_INCLUDE_ATTENDANCES ?? 'true').toLowerCase() === 'true',
        trimesterBoundaries: TRIMESTERS,
        exportStartAt: process.env.EXPORT_START_AT || '2025-09-01',
        exportStopAt: process.env.EXPORT_STOP_AT || '2026-08-31'
      });
    }

    if (req.method === 'POST' && req.url === '/api/mesh') {
      const payload = await readBody(req);
      const result = await proxyMesh(payload);
      return json(res, 200, result);
    }

    return serveStatic(req, res);
  } catch (err) {
    return json(res, 500, { error: err.message || 'Internal error' });
  }
});

server.listen(PORT, () => {
  console.log(`Web UI: http://localhost:${PORT}`);
});
