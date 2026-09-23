const crypto = require('node:crypto');
const path = require('node:path');
const { TelegramStore } = require('./telegram-store.cjs');

const hashToken = (value) => crypto.createHash('sha256').update(value).digest('hex');
const token = () => crypto.randomBytes(32).toString('hex');
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const errorCode = (err) => String(err.errorMessage || err.message || 'UNKNOWN');
const isExpired = (err) => /AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|AUTH_KEY_DUPLICATED/.test(errorCode(err));
const secondsToWait = (err) => /FLOOD.*WAIT|SLOWMODE_WAIT|SLOW_MODE_WAIT/.test(errorCode(err))
  ? Math.max(1, Number(err.seconds) || Number(errorCode(err).match(/_(\d+)$/)?.[1]) || 60) : 0;
const safeCode = (err) => errorCode(err).match(/^[A-Z][A-Z_0-9]+$/)?.[0] || 'CONNECTION_ERROR';
const active = (job) => ['running', 'waiting'].includes(job.status);

function createTelegramService({ env = process.env, store: providedStore, adapterFactory,
  now = Date.now, schedule = setTimeout, cancelSchedule = clearTimeout } = {}) {
  const apiId = Number(env.TELEGRAM_API_ID);
  const apiHash = env.TELEGRAM_API_HASH || '';
  const configured = Boolean(Number.isInteger(apiId) && apiId > 0 && /^[a-f0-9]{32}$/i.test(apiHash));
  const intervalMs = Math.max(5000, Number(env.TELEGRAM_SEND_INTERVAL_MS) || 30000);
  let store = providedStore;
  const clients = new Map();
  const pending = new Map();
  const locks = new Set();
  const timers = new Map();
  const sendingAccounts = new Set();
  const limits = new Map();
  let closed = false;

  function database() {
    if (!store) {
      const directory = path.resolve(env.TELEGRAM_DATA_DIR || path.join(__dirname, '..', '.telegram-data'));
      const webRoot = path.join(__dirname, '..', 'web');
      const relative = path.relative(webRoot, directory);
      if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
        fail('Хранилище Telegram должно находиться вне каталога web.', 503);
      }
      store = new TelegramStore(directory, env.TELEGRAM_SESSION_KEY);
    }
    return store.data;
  }
  function save() { store.save(); }
  function newClient(session = '') {
    const factory = adapterFactory || require('./telegram-adapter.cjs').createTelegramAdapter;
    return factory(session, apiId, apiHash);
  }
  function rateLimit(key, maximum, period) {
    if (limits.size > 10000) for (const [k, value] of limits) if (value.until <= now()) limits.delete(k);
    const entry = limits.get(key) || { count: 0, until: now() + period };
    if (entry.until <= now()) { entry.count = 0; entry.until = now() + period; }
    if (++entry.count > maximum) fail('Слишком много попыток. Повторите позже.', 429);
    limits.set(key, entry);
  }
  function authenticate(bearer) {
    if (!/^[a-f0-9]{64}$/.test(bearer)) fail('Войдите в Telegram.', 401);
    const key = hashToken(bearer);
    const session = database().sessions[key];
    if (!session || session.expires <= now()) fail('Сессия истекла. Войдите в Telegram снова.', 401);
    return { key, session, account: database().accounts[session.user.id] };
  }
  async function getClient(key, session) {
    if (!clients.has(key)) {
      const client = newClient(session.secret);
      clients.set(key, client);
      try { await client.connect(); } catch (err) { clients.delete(key); await client.disconnect().catch(() => {}); throw err; }
    }
    return clients.get(key);
  }
  function publicState(session, account) {
    return { user: session.user, intervalMs,
      nextSendAt: account.nextSendAt || 0, restricted: Boolean(account.restricted),
      jobs: account.jobs.map((job) => ({ ...job,
        recipients: job.recipients.map(({ accessHash, randomId, ...recipient }) => recipient) })) };
  }
  function scheduleJob(key, account, job, delay = 0) {
    if (closed) return;
    const timer = schedule(() => {
      timers.delete(job.id);
      return runJob(key, account, job).catch(() => {
        job.status = 'paused'; job.note = 'Ошибка очереди. Проверьте отправленные сообщения.';
        for (const recipient of job.recipients) if (recipient.status === 'sending') recipient.status = 'unknown';
        try { save(); } catch (_) { /* Never continue sending after a storage failure. */ }
      });
    }, Math.min(delay, 2147483647));
    timer?.unref?.();
    timers.set(job.id, timer);
  }
  async function runJob(key, account, job) {
    if (closed || !active(job)) return;
    const session = database().sessions[key];
    if (!session || session.expires <= now()) {
      job.status = 'paused'; job.note = 'Для продолжения войдите в Telegram.'; save(); return;
    }
    const recipient = job.recipients.find((item) => item.status === 'pending');
    if (!recipient) { job.status = 'completed'; save(); return; }
    const wait = Math.max(0, (account.nextSendAt || 0) - now());
    if (wait) { job.status = 'waiting'; save(); scheduleJob(key, account, job, wait); return; }
    if (sendingAccounts.has(session.user.id)) { scheduleJob(key, account, job, 1000); return; }
    sendingAccounts.add(session.user.id);
    job.status = 'running';
    try {
      const client = await getClient(key, session);
      if (!active(job) || closed) return;
      recipient.status = 'sending';
      account.nextSendAt = now() + intervalMs;
      save(); // Persist intent before the external side effect.
      await client.send(recipient, job.message);
      recipient.status = 'sent'; recipient.sentAt = now();
    } catch (err) {
      const cancelled = job.status === 'cancelled';
      const waitSeconds = secondsToWait(err);
      const code = safeCode(err);
      recipient.error = code;
      if (waitSeconds) {
        recipient.status = 'pending';
        account.nextSendAt = Math.max(account.nextSendAt || 0, now() + waitSeconds * 1000);
        job.status = 'paused'; job.note = 'Telegram требует паузу. Продолжение доступно после указанного времени.';
      } else if (/PEER_FLOOD|FROZEN|USER_RESTRICTED|PHONE_NUMBER_BANNED|USER_DEACTIVATED/.test(errorCode(err))) {
        recipient.status = 'failed'; account.restricted = true;
        job.status = 'paused'; job.note = 'Telegram ограничил отправку. Проверьте аккаунт через @SpamBot. Рассылка остановлена.';
      } else if (isExpired(err)) {
        recipient.status = 'failed'; delete database().sessions[key];
        job.status = 'paused'; job.note = 'Telegram отозвал сессию. Войдите снова.';
      } else if (/USER_IS_BLOCKED|YOU_BLOCKED_USER|USER_PRIVACY_RESTRICTED|INPUT_USER_DEACTIVATED|PRIVACY_PREMIUM_REQUIRED|ALLOW_PAYMENT_REQUIRED/.test(errorCode(err))) {
        recipient.status = 'failed';
      } else {
        recipient.status = recipient.status === 'sending' ? 'unknown' : 'pending';
        job.status = 'paused'; job.note = 'Не удалось подтвердить отправку. Проверьте диалог; автоматического повтора не будет.';
      }
      if (cancelled) {
        job.status = 'cancelled';
        if (recipient.status === 'pending') recipient.status = 'cancelled';
      }
    } finally {
      sendingAccounts.delete(session.user.id);
    }
    save();
    if (active(job)) {
      if (!job.recipients.some((item) => item.status === 'pending')) { job.status = 'completed'; save(); }
      else scheduleJob(key, account, job, Math.max(0, account.nextSendAt - now()));
    }
  }

  async function handle(action, body = {}, bearer = '', ip = 'local') {
    if (action === 'config') return { configured, intervalMs };
    if (!configured) fail('На сервере нужно указать TELEGRAM_API_ID и TELEGRAM_API_HASH в .env.', 503);
    if (action === 'login') {
      const phone = String(body.phone || '').replace(/[ ()-]/g, '');
      if (!/^\+[1-9]\d{6,14}$/.test(phone)) fail('Введите номер с кодом страны, например +79991234567.');
      rateLimit(`ip:${ip}`, 5, 15 * 60000);
      rateLimit(`phone:${hashToken(phone)}`, 3, 15 * 60000);
      if (pending.size >= 50) fail('Слишком много незавершённых входов. Повторите позже.', 429);
      const loginToken = token();
      const client = newClient();
      try {
        await client.connect();
        const result = await client.sendCode(phone);
        if (result.emailRequired || result.emailCodeSent) fail('Telegram запросил проверку email. Этот способ входа пока не поддерживается.');
        if (!result.phoneCodeHash) fail('Telegram не выдал код входа. Проверьте аккаунт в официальном приложении.');
        pending.set(loginToken, { client, phone, hash: result.phoneCodeHash, expires: now() + 10 * 60000, attempts: 0 });
        return { loginToken, viaApp: result.isCodeViaApp };
      } catch (err) { await client.disconnect().catch(() => {}); throw err; }
    }
    if (action === 'code' || action === 'password') {
      const login = pending.get(bearer);
      if (!login || login.expires <= now()) fail('Время входа истекло. Запросите новый код.', 401);
      if (locks.has(bearer)) fail('Дождитесь завершения входа.', 409);
      if (++login.attempts > 6) fail('Слишком много попыток. Начните вход заново.', 429);
      if (login.waitUntil > now()) fail('Telegram требует паузу перед следующей попыткой.', 429);
      locks.add(bearer);
      try {
        let user;
        if (action === 'code') {
          if (!/^\d{4,8}$/.test(String(body.code || ''))) fail('Введите код из Telegram.');
          user = await login.client.signIn(login.phone, login.hash, body.code);
        } else {
          if (!login.needsPassword) fail('Сначала подтвердите код.');
          if (typeof body.password !== 'string' || !body.password || body.password.length > 256) fail('Введите пароль двухэтапной аутентификации.');
          user = await login.client.password(body.password);
        }
        const accessToken = token();
        const key = hashToken(accessToken);
        const session = { secret: login.client.save(), user: { id: user.id.toString(),
          name: [user.firstName, user.lastName].filter(Boolean).join(' '), username: user.username || '' }, expires: now() + 30 * 86400000 };
        const data = database();
        data.sessions[key] = session;
        data.accounts[session.user.id] ||= { jobs: [], nextSendAt: 0, restricted: false };
        save();
        pending.delete(bearer); clients.set(key, login.client);
        return { token: accessToken, ...publicState(session, data.accounts[session.user.id]) };
      } catch (err) {
        if (/SESSION_PASSWORD_NEEDED/.test(errorCode(err))) { login.needsPassword = true; return { needsPassword: true }; }
        const wait = secondsToWait(err);
        if (wait) login.waitUntil = now() + wait * 1000;
        throw err;
      } finally { locks.delete(bearer); }
    }
    const { key, session, account } = authenticate(bearer);
    if (locks.has(key)) fail('Дождитесь завершения предыдущего действия.', 409);
    locks.add(key);
    try {
      if (action === 'state') return publicState(session, account);
      if (action === 'acknowledge-restriction') {
        if (body.confirmed !== true) fail('Подтвердите, что проверили снятие ограничений в Telegram.');
        if (account.nextSendAt > now()) fail('Пауза Telegram ещё не закончилась.', 429);
        account.restricted = false; save(); return publicState(session, account);
      }
      if (action === 'contacts') {
        rateLimit(`contacts:${session.user.id}`, 10, 60000);
        if ((account.nextSendAt || 0) > now() && account.jobs.some((job) => job.status === 'paused')) fail('Дождитесь окончания паузы Telegram.', 429);
        const client = await getClient(key, session);
        const contacts = await client.contacts();
        return { contacts: contacts.map(({ accessHash, ...contact }) => contact) };
      }
      if (action === 'send') {
        if (!/^[a-f0-9-]{36}$/.test(body.requestId || '')) fail('Некорректный идентификатор отправки.');
        const existing = account.jobs.find((job) => job.id === body.requestId);
        if (existing) return publicState(session, account);
        if (account.restricted) fail('Отправка остановлена из-за ограничения Telegram. Проверьте @SpamBot.');
        if (sendingAccounts.has(session.user.id) || account.jobs.some((job) => active(job) || job.status === 'paused')) fail('Сначала завершите или остановите текущую рассылку.', 409);
        if (account.nextSendAt > now()) fail('Дождитесь окончания паузы перед новой рассылкой.', 429);
        const group = body.group;
        if (!group || typeof group.name !== 'string' || !group.name.trim() || group.name.length > 80) fail('Укажите название группы.');
        if (!Array.isArray(group.contactIds) || !group.contactIds.length || group.contactIds.length > 100) fail('Выберите от 1 до 100 контактов.');
        const memberIds = [...new Set(group.contactIds.map(String))];
        const message = typeof body.message === 'string' ? body.message.trim() : '';
        if (!message || message.length > 4096) fail('Сообщение должно содержать от 1 до 4096 символов.');
        if (body.expected !== true) fail('Подтвердите, что получатели ожидают эти сообщения.');
        // Refresh membership before sending; never fall back to username search.
        const client = await getClient(key, session);
        const contacts = await client.contacts();
        if (memberIds.some((id) => !contacts.some((c) => c.id === id))) fail('Часть участников отсутствует в контактах Telegram. Обновите состав группы.');
        // Other sessions for this account may have submitted while contacts loaded.
        if (account.jobs.some((job) => job.id === body.requestId)) return publicState(session, account);
        if (sendingAccounts.has(session.user.id) || account.jobs.some((job) => active(job) || job.status === 'paused')) fail('Рассылка уже запущена.', 409);
        if (account.restricted || account.nextSendAt > now()) fail('Отправка временно приостановлена.', 429);
        const job = { id: body.requestId, groupName: group.name, message, createdAt: now(), status: 'running', note: '',
          recipients: memberIds.map((id) => ({ ...contacts.find((c) => c.id === id),
            randomId: crypto.randomBytes(8).readBigInt64BE().toString(), status: 'pending' })) };
        account.jobs = [...account.jobs.slice(-19), job]; save(); scheduleJob(key, account, job);
        return publicState(session, account);
      }
      if (action === 'stop' || action === 'resume') {
        const job = account.jobs.find((j) => j.id === body.id);
        if (!job) fail('Рассылка не найдена.', 404);
        if (action === 'stop') {
          if (!['running', 'waiting', 'paused'].includes(job.status)) fail('Рассылка уже завершена.');
          job.status = 'cancelled'; job.note = 'Остановлено. Уже начатая отправка может завершиться.';
          for (const item of job.recipients) if (item.status === 'pending') item.status = 'cancelled';
          cancelSchedule(timers.get(job.id)); timers.delete(job.id);
        } else {
          if (job.status !== 'paused' || account.restricted) fail('Эту рассылку сейчас нельзя продолжить.');
          if (account.nextSendAt > now()) fail('Пауза Telegram ещё не закончилась.', 429);
          if (account.jobs.some(active)) fail('Другая рассылка уже запущена.', 409);
          job.status = 'running'; job.note = ''; scheduleJob(key, account, job);
        }
        save(); return publicState(session, account);
      }
      if (action === 'logout') {
        if (account.jobs.some(active) || sendingAccounts.has(session.user.id)) fail('Сначала остановите рассылку и дождитесь текущей отправки.');
        const client = await getClient(key, session);
        await client.logout();
        delete database().sessions[key]; save(); clients.delete(key);
        await client.disconnect(); return { ok: true };
      }
      fail('Действие не найдено.', 404);
    } catch (err) {
      if (isExpired(err)) { delete database().sessions[key]; save(); fail('Сессия Telegram отозвана. Войдите снова.', 401); }
      if (/PEER_FLOOD|FROZEN|USER_RESTRICTED|PHONE_NUMBER_BANNED|USER_DEACTIVATED/.test(errorCode(err))) {
        account.restricted = true;
        for (const job of account.jobs) if (active(job)) {
          job.status = 'paused'; job.note = 'Telegram ограничил аккаунт. Проверьте @SpamBot.';
          cancelSchedule(timers.get(job.id)); timers.delete(job.id);
        }
        save();
      }
      const wait = secondsToWait(err);
      if (wait) { account.nextSendAt = Math.max(account.nextSendAt || 0, now() + wait * 1000); save(); }
      throw err;
    } finally { locks.delete(key); }
  }
  const cleanup = setInterval(() => {
    for (const [key, login] of pending) {
      if (login.expires <= now() && !locks.has(key)) { pending.delete(key); login.client.disconnect().catch(() => {}); }
    }
    if (store) {
      let changed = false;
      for (const [key, session] of Object.entries(store.data.sessions)) {
        if (session.expires <= now() && !locks.has(key) && !sendingAccounts.has(session.user.id)) {
          delete store.data.sessions[key]; changed = true;
          const client = clients.get(key); clients.delete(key);
          client?.disconnect().catch(() => {});
        }
      }
      if (changed) { try { save(); } catch (_) { /* Expired tokens remain rejected in memory. */ } }
    }
  }, 60000);
  cleanup.unref();
  return { handle, async close() {
    closed = true; clearInterval(cleanup);
    for (const timer of timers.values()) cancelSchedule(timer);
    await Promise.allSettled([...clients.values(), ...[...pending.values()].map((x) => x.client)].map((c) => c.disconnect()));
  } };
}

function publicError(err) {
  if (err.status) return { status: err.status, error: err.message };
  const wait = secondsToWait(err);
  if (wait) return { status: 429, error: `Telegram требует подождать ${wait} сек.`, retryAfter: wait };
  const code = safeCode(err);
  const messages = { PHONE_CODE_INVALID: 'Неверный код.', PHONE_CODE_EXPIRED: 'Код истёк. Начните вход заново.',
    PASSWORD_HASH_INVALID: 'Неверный пароль.', PHONE_NUMBER_INVALID: 'Неверный номер телефона.',
    PHONE_NUMBER_BANNED: 'Номер заблокирован Telegram.', ACCOUNT_REQUIRED: 'Нужен существующий аккаунт Telegram.',
    API_ID_INVALID: 'Проверьте TELEGRAM_API_ID и TELEGRAM_API_HASH на сервере.' };
  return { status: 400, error: messages[code] || `Telegram: ${code}. Повторите позже или проверьте аккаунт в официальном приложении.` };
}

module.exports = { createTelegramService, publicError, hashToken };
