const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { chromium } = require('playwright');
require('dotenv').config();

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  return String(raw).toLowerCase() === 'true';
}

function intEnv(name, fallback) {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) ? raw : fallback;
}

function truncate(value, maxLen) {
  const text = String(value || '');
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}... [truncated ${text.length - maxLen} chars]`;
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch (_) {
    return null;
  }
}

function appendJsonl(stream, payload) {
  stream.write(`${JSON.stringify(payload)}\n`);
}

function nowIso() {
  return new Date().toISOString();
}

function outputStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function bodyIsReadable(contentType) {
  const c = String(contentType || '').toLowerCase();
  return (
    c.includes('application/json') ||
    c.includes('application/problem+json') ||
    c.includes('application/xml') ||
    c.includes('text/')
  );
}

async function waitForStopSignal() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });

    let done = false;
    const finish = (reason) => {
      if (done) return;
      done = true;
      rl.close();
      resolve(reason);
    };

    rl.question('Press Enter to stop tracing and save files... ', () => finish('enter'));
    process.once('SIGINT', () => finish('sigint'));
  });
}

async function main() {
  const startUrl = process.env.TRACE_START_URL || process.env.MESH_LOGIN_URL || 'https://school.mos.ru/';
  const headless = boolEnv('HEADLESS', false);
  const usePersistentProfile = boolEnv('USE_PERSISTENT_PROFILE', true);
  const profileDir = path.resolve(process.env.BROWSER_PROFILE_DIR || 'output/browser-profile');
  const maxBodyLen = intEnv('TRACE_MAX_BODY_LEN', 60000);
  const saveBodies = boolEnv('TRACE_SAVE_BODIES', true);

  const runDir = path.resolve('output', `trace-${outputStamp()}`);
  fs.mkdirSync(runDir, { recursive: true });

  const requestsPath = path.join(runDir, 'http-requests.jsonl');
  const responsesPath = path.join(runDir, 'http-responses.jsonl');
  const errorsPath = path.join(runDir, 'http-errors.jsonl');
  const harPath = path.join(runDir, 'network.har');
  const tracePath = path.join(runDir, 'trace.zip');
  const metaPath = path.join(runDir, 'meta.json');

  const reqStream = fs.createWriteStream(requestsPath, { flags: 'a' });
  const resStream = fs.createWriteStream(responsesPath, { flags: 'a' });
  const errStream = fs.createWriteStream(errorsPath, { flags: 'a' });

  const meta = {
    startedAt: nowIso(),
    startUrl,
    headless,
    usePersistentProfile,
    profileDir: usePersistentProfile ? profileDir : null,
    outputs: {
      runDir,
      requestsPath,
      responsesPath,
      errorsPath,
      harPath,
      tracePath
    }
  };
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

  let browser = null;
  let context = null;
  if (usePersistentProfile) {
    fs.mkdirSync(profileDir, { recursive: true });
    context = await chromium.launchPersistentContext(profileDir, {
      headless,
      recordHar: { path: harPath, content: 'embed', mode: 'full' }
    });
  } else {
    browser = await chromium.launch({ headless });
    context = await browser.newContext({
      recordHar: { path: harPath, content: 'embed', mode: 'full' }
    });
  }

  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });

  let reqId = 0;
  context.on('request', (request) => {
    const id = ++reqId;
    request.__trace_id = id;
    appendJsonl(reqStream, {
      id,
      at: nowIso(),
      pageUrl: request.frame() ? request.frame().page().url() : null,
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      headers: request.headers(),
      postData: truncate(request.postData() || '', maxBodyLen)
    });
  });

  context.on('response', async (response) => {
    const request = response.request();
    const id = request.__trace_id || null;
    const headers = response.headers();
    const contentType = headers['content-type'] || '';
    const payload = {
      id,
      at: nowIso(),
      requestUrl: request.url(),
      method: request.method(),
      status: response.status(),
      statusText: response.statusText(),
      ok: response.ok(),
      headers,
      contentType
    };

    if (saveBodies && bodyIsReadable(contentType)) {
      try {
        const text = await response.text();
        payload.bodyText = truncate(text, maxBodyLen);
        const json = safeJsonParse(text);
        if (json !== null) payload.bodyJson = json;
      } catch (error) {
        payload.bodyReadError = String(error && error.message ? error.message : error);
      }
    }

    appendJsonl(resStream, payload);
  });

  context.on('requestfailed', (request) => {
    const failure = request.failure();
    appendJsonl(errStream, {
      id: request.__trace_id || null,
      at: nowIso(),
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      errorText: failure ? failure.errorText : 'unknown'
    });
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto(startUrl, { waitUntil: 'domcontentloaded' });

  console.log(`Tracing started. Navigate in browser as needed.`);
  console.log(`Output directory: ${runDir}`);
  console.log(`Requests: ${requestsPath}`);
  console.log(`Responses: ${responsesPath}`);
  console.log(`HAR: ${harPath}`);

  const stopReason = await waitForStopSignal();

  await context.tracing.stop({ path: tracePath });
  await context.close();
  if (browser) await browser.close();
  reqStream.end();
  resStream.end();
  errStream.end();

  const finalMeta = {
    ...meta,
    stoppedAt: nowIso(),
    stopReason
  };
  fs.writeFileSync(metaPath, JSON.stringify(finalMeta, null, 2));

  console.log(`Tracing stopped (${stopReason}).`);
  console.log(`Saved: ${runDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
