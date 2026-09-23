import { escapeHtml as esc } from '../utils.js';
import { TELEGRAM_TOKEN_KEY, loadTelegramGroups, saveTelegramGroups } from '../telegram-storage.js';
import { telegramRequest } from '../telegram-api.js';

const labels = { pending: 'В очереди', sending: 'Отправляется', sent: 'Отправлено', failed: 'Ошибка',
  unknown: 'Результат неизвестен — проверьте диалог', cancelled: 'Остановлено', running: 'Отправка',
  waiting: 'Пауза между сообщениями', paused: 'Приостановлено', completed: 'Завершено' };
const requestId = () => crypto.randomUUID ? crypto.randomUUID() : '10000000-1000-4000-8000-100000000000'.replace(/[018]/g, (c) =>
  (Number(c) ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> Number(c) / 4).toString(16));

export class MailingsScreen {
  constructor(root) {
    this.root = root;
    this.token = localStorage.getItem(TELEGRAM_TOKEN_KEY) || '';
    this.groups = []; this.contacts = []; this.selected = ''; this.data = null;
    this.requestId = requestId();
    root.innerHTML = `
      <div class="panel p-3 p-md-4 mb-3">
        <div class="d-flex justify-content-between align-items-center gap-2 flex-wrap">
          <div><h2 class="h5 fw-bold mb-1">Рассылки в Telegram</h2><p class="small-muted mb-0">Личные сообщения от вашего аккаунта. Группы сохраняются в этом браузере.</p></div>
          <button data-ref="logout" class="btn btn-outline-secondary btn-sm" hidden>Выйти из Telegram</button>
        </div>
        <div data-ref="status" role="status" aria-live="polite" class="mt-3" hidden></div>
        <div data-ref="account" class="small-muted mt-2"></div>
      </div>
      <div data-ref="loginPanel" class="panel p-3 p-md-4">
        <h3 class="h6 fw-bold">Подключить Telegram</h3>
        <p class="small-muted">Приложение использует Telegram API. Подключение сохранится; повторный вход обычно не нужен.</p>
        <p data-ref="setup" class="alert alert-info" hidden>Для подключения укажите на сервере <code>TELEGRAM_API_ID</code> и <code>TELEGRAM_API_HASH</code> в <code>.env</code> и перезапустите приложение. Получить их можно в <a href="https://my.telegram.org/apps" target="_blank" rel="noopener noreferrer">Telegram API development tools</a>.</p>
        <form data-ref="loginForm" style="max-width:440px">
          <label for="tgPhone" class="form-label">Номер телефона</label>
          <input id="tgPhone" data-ref="phone" class="form-control" type="tel" autocomplete="tel" placeholder="+7 999 123-45-67" required>
          <div data-ref="codeWrap" class="mt-3" hidden><label for="tgCode" class="form-label">Код подтверждения</label>
            <input id="tgCode" data-ref="code" class="form-control" inputmode="numeric" autocomplete="one-time-code"></div>
          <div data-ref="passwordWrap" class="mt-3" hidden><label for="tgPassword" class="form-label">Пароль двухэтапной аутентификации</label>
            <input id="tgPassword" data-ref="password" class="form-control" type="password" autocomplete="current-password"></div>
          <div class="d-flex gap-2 mt-3"><button data-ref="loginSubmit" class="btn btn-primary">Получить код</button>
            <button data-ref="restart" type="button" class="btn btn-outline-secondary" hidden>Начать заново</button></div>
        </form>
      </div>
      <div data-ref="workspace" hidden>
        <div data-ref="restriction" class="alert alert-warning" hidden>Telegram ограничил отправку. Проверьте аккаунт через <a href="https://t.me/SpamBot" target="_blank" rel="noopener noreferrer">@SpamBot</a>.
          <button data-ref="acknowledge" class="btn btn-sm btn-outline-secondary ms-2">Ограничения сняты</button></div>
        <div class="row g-3">
          <aside class="col-lg-4"><div class="panel p-3">
            <div class="d-flex justify-content-between align-items-center mb-3"><h3 class="h6 fw-bold mb-0">Мои группы</h3><button data-ref="newGroup" class="btn btn-sm btn-outline-primary">+ Группа</button></div>
            <div data-ref="groups"></div>
          </div></aside>
          <div class="col-lg-8"><div class="panel p-3 p-md-4">
            <div data-ref="empty" class="small-muted">Создайте группу и добавьте людей из контактов Telegram.</div>
            <div data-ref="composer" hidden>
              <div class="d-flex justify-content-between align-items-center gap-2 flex-wrap mb-2">
                <h3 data-ref="groupTitle" class="h5 fw-bold mb-0"></h3>
                <div class="d-flex gap-2"><button data-ref="editGroup" class="btn btn-sm btn-outline-primary">+ Контакты / изменить</button><button data-ref="deleteGroup" class="btn btn-sm btn-outline-danger">Удалить</button></div>
              </div>
              <p class="small-muted">Это список получателей, а не групповой чат Telegram.</p>
              <div data-ref="members" class="mb-3 tg-members"></div>
              <form data-ref="messageForm">
                <label for="tgMessage" class="form-label fw-bold">Сообщение каждому участнику</label>
                <textarea id="tgMessage" data-ref="message" class="form-control" rows="6" maxlength="4096" required placeholder="Напишите сообщение…"></textarea>
                <div data-ref="count" class="small-muted text-end mt-1">0 / 4096</div>
                <p data-ref="pace" class="small-muted mt-2"></p>
                <div class="form-check mt-3"><input id="tgExpected" data-ref="expected" class="form-check-input" type="checkbox" required>
                  <label for="tgExpected" class="form-check-label small">Получатели ожидают это сообщение. Понимаю, что Telegram может ограничить аккаунт даже при отправке с паузами.</label></div>
                <button data-ref="send" class="btn btn-primary mt-3">Отправить</button>
              </form>
            </div>
          </div></div>
        </div>
        <div class="panel p-3 p-md-4 mt-3"><h3 class="h6 fw-bold">История отправки</h3><div data-ref="jobs" aria-live="polite"></div></div>
      </div>
      <dialog data-ref="editor" class="tg-dialog panel">
        <form data-ref="groupForm">
          <div class="d-flex justify-content-between align-items-center mb-3"><h3 class="h5 mb-0">Группа рассылки</h3><button data-ref="closeEditor" type="button" class="btn btn-sm btn-outline-secondary" aria-label="Закрыть">✕</button></div>
          <label for="tgGroupName" class="form-label">Название</label><input id="tgGroupName" data-ref="groupName" class="form-control mb-3" maxlength="80" required>
          <label for="tgSearch" class="form-label">Добавить из контактов</label><input id="tgSearch" data-ref="search" class="form-control mb-2" type="search" placeholder="Имя или @username">
          <div data-ref="contactCount" class="small-muted mb-2"></div>
          <div data-ref="contacts" class="tg-contact-list"></div>
          <div data-ref="editorError" class="text-danger small mt-2" role="alert"></div>
          <button class="btn btn-primary mt-3">Сохранить группу</button>
        </form>
      </dialog>`;
    this.refs = Object.fromEntries([...root.querySelectorAll('[data-ref]')].map((el) => [el.dataset.ref, el]));
    const r = this.refs;
    r.loginForm.addEventListener('submit', (event) => { event.preventDefault(); this.act(() => this.login()); });
    r.restart.onclick = () => this.resetLogin();
    r.logout.onclick = () => this.act(async () => { await this.api('logout'); this.clearSession(); this.notice('Вы вышли из Telegram. Группы сохранены в этом браузере.'); });
    r.acknowledge.onclick = () => {
      if (!confirm('Вы проверили аккаунт в Telegram и убедились, что ограничения сняты? Эта кнопка только снимает локальную остановку очереди.')) return;
      this.act(async () => { this.data = await this.api('acknowledge-restriction', { confirmed: true }); this.renderJobs(); });
    };
    r.newGroup.onclick = () => this.act(() => this.edit());
    r.editGroup.onclick = () => this.act(() => this.edit(this.selected));
    r.closeEditor.onclick = () => r.editor.close();
    r.search.oninput = () => this.renderContacts();
    r.contacts.onchange = (event) => {
      const input = event.target.closest('input[data-id]'); if (!input) return;
      if (input.checked) this.chosen.add(input.dataset.id); else this.chosen.delete(input.dataset.id);
      r.contactCount.textContent = `Выбрано: ${this.chosen.size} / 100`;
    };
    r.groupForm.onsubmit = (event) => { event.preventDefault(); this.saveGroup(); };
    r.deleteGroup.onclick = () => {
      const group = this.group();
      if (!group || !confirm(`Удалить группу «${group.name}» из этого браузера?`)) return;
      this.act(async () => { this.persistGroups(this.groups.filter((item) => item.id !== group.id)); this.selected = this.groups[0]?.id || ''; this.renderGroups(); });
    };
    r.groups.onclick = (event) => {
      const button = event.target.closest('[data-group]'); if (!button || this.busy) return;
      this.selected = button.dataset.group; this.requestId = requestId(); r.expected.checked = false; this.renderGroups();
    };
    r.message.oninput = () => { r.count.textContent = `${r.message.value.length} / 4096`; this.requestId = requestId(); this.renderControls(); };
    r.expected.onchange = () => this.renderControls();
    r.messageForm.onsubmit = (event) => { event.preventDefault(); this.act(async () => {
      const group = this.group();
      this.data = await this.api('send', { requestId: this.requestId, group: { name: group.name, contactIds: group.members.map((m) => m.id) }, message: r.message.value, expected: r.expected.checked });
      r.message.value = ''; r.expected.checked = false; r.count.textContent = '0 / 4096'; this.requestId = requestId();
      this.renderJobs(); this.notice('Рассылка запущена. Результаты появятся в истории.');
    }); };
    r.jobs.onclick = (event) => {
      const button = event.target.closest('[data-action]'); if (!button) return;
      this.act(async () => { this.data = await this.api(button.dataset.action, { id: button.dataset.job }); this.renderJobs(); });
    };
  }

  async api(action, body = {}, auth = this.token) {
    try { return await telegramRequest(action, body, auth); }
    catch (err) {
      if (err.status === 401 && auth === this.token) this.clearSession();
      if (err.restartLogin && ['login', 'code', 'password'].includes(action)) this.resetLogin();
      throw err;
    }
  }
  notice(text, error = false) {
    this.refs.status.hidden = !text; this.refs.status.className = `mt-3 alert ${error ? 'alert-danger' : 'alert-info'}`;
    this.refs.status.textContent = text;
  }
  async act(fn) {
    if (this.busy) return;
    this.busy = true; this.notice(''); this.renderControls();
    try { await fn(); } catch (err) { this.notice(err.message || 'Не удалось выполнить действие.', true); }
    finally { this.busy = false; this.renderControls(); }
  }
  async show() {
    this.visible = true;
    await this.act(async () => {
      const config = await this.api('config'); this.configured = config.configured;
      this.refs.setup.hidden = config.configured;
      if (!window.isSecureContext) {
        this.configured = false;
        this.notice('Для входа в Telegram откройте приложение через HTTPS или localhost.', true);
      }
      if (this.token && this.configured) {
        this.data = await this.api('state');
        this.groups = loadTelegramGroups(localStorage, this.data.user.id);
        if (!this.group()) this.selected = this.groups[0]?.id || '';
      }
      this.render();
    });
    clearInterval(this.poller);
    this.poller = setInterval(() => this.poll(), 2500);
  }
  hide() { this.visible = false; clearInterval(this.poller); }
  async poll() {
    if (!this.visible || !this.token || !this.data || this.busy || this.polling) return;
    this.polling = true;
    try { this.data = await this.api('state'); this.renderJobs(); this.renderControls(); }
    catch (err) { this.notice(err.message, true); }
    finally { this.polling = false; }
  }
  resetLogin() {
    this.loginToken = ''; this.needsPassword = false;
    this.refs.phone.disabled = false; this.refs.code.value = ''; this.refs.password.value = '';
    this.refs.codeWrap.hidden = true; this.refs.passwordWrap.hidden = true; this.refs.restart.hidden = true;
    this.refs.loginSubmit.textContent = 'Получить код'; this.notice('');
  }
  clearSession() { localStorage.removeItem(TELEGRAM_TOKEN_KEY); this.token = ''; this.data = null; this.groups = []; this.selected = ''; this.resetLogin(); this.render(); }
  async login() {
    const r = this.refs;
    if (!window.isSecureContext) throw new Error('Вход доступен только через HTTPS или localhost.');
    if (!this.loginToken) {
      this.notice('Соединяемся с Telegram и запрашиваем код. Это может занять до 40 секунд…');
      const result = await this.api('login', { phone: r.phone.value }, '');
      this.loginToken = result.loginToken; r.phone.disabled = true; r.codeWrap.hidden = false; r.restart.hidden = false;
      r.loginSubmit.textContent = 'Подтвердить код'; r.code.focus();
      this.notice(result.viaApp ? 'Код отправлен в приложение Telegram.' : 'Введите код, отправленный Telegram.'); return;
    }
    let result;
    try { result = await this.api(this.needsPassword ? 'password' : 'code', this.needsPassword ? { password: r.password.value } : { code: r.code.value.trim() }, this.loginToken); }
    finally { r.password.value = ''; }
    if (result.needsPassword) {
      this.needsPassword = true; r.codeWrap.hidden = true; r.passwordWrap.hidden = false;
      r.loginSubmit.textContent = 'Войти'; r.password.focus(); return;
    }
    localStorage.setItem(TELEGRAM_TOKEN_KEY, result.token); this.token = result.token;
    this.data = result; this.groups = loadTelegramGroups(localStorage, result.user.id); this.selected = this.groups[0]?.id || '';
    this.resetLogin(); this.render();
  }
  group() { return this.groups.find((group) => group.id === this.selected); }
  persistGroups(groups) { saveTelegramGroups(localStorage, this.data.user.id, groups); this.groups = groups; }
  async edit(id = '') {
    const r = this.refs;
    this.notice('Загружаем контакты Telegram…');
    this.contacts = (await this.api('contacts')).contacts;
    const group = this.groups.find((item) => item.id === id);
    this.editId = id; this.chosen = new Set(group?.members.map((item) => item.id) || []);
    // Keep unavailable members visible so the user can remove them explicitly.
    this.unavailable = (group?.members || []).filter((m) => !this.contacts.some((c) => c.id === m.id));
    r.groupName.value = group?.name || ''; r.search.value = ''; r.editorError.textContent = '';
    this.renderContacts(); r.editor.showModal(); this.notice('');
  }
  renderContacts() {
    const search = this.refs.search.value.toLocaleLowerCase('ru');
    const rows = [...this.contacts, ...(this.unavailable || []).map((c) => ({ ...c, unavailable: true }))]
      .filter((c) => `${c.name} ${c.username}`.toLocaleLowerCase('ru').includes(search));
    this.refs.contacts.innerHTML = rows.map((c) => `<label class="tg-contact"><input class="form-check-input me-2" type="checkbox" data-id="${esc(c.id)}" ${this.chosen.has(c.id) ? 'checked' : ''}><span>${esc(c.name)}<small class="d-block small-muted">${c.unavailable ? 'Больше нет в контактах — удалите из группы' : c.username ? `@${esc(c.username)}` : 'Контакт Telegram'}</small></span></label>`).join('') || '<p class="small-muted">Контакты не найдены.</p>';
    this.refs.contactCount.textContent = `Выбрано: ${this.chosen.size} / 100`;
  }
  saveGroup() {
    try {
      const name = this.refs.groupName.value.trim();
      if (!name) throw new Error('Введите название группы.');
      if (this.chosen.size > 100) throw new Error('В группе может быть не более 100 контактов.');
      if (!this.editId && this.groups.length >= 100) throw new Error('Можно создать не более 100 групп.');
      const members = [...this.chosen].map((id) => this.contacts.find((c) => c.id === id));
      if (members.some((m) => !m)) throw new Error('Удалите участников, которых больше нет в контактах.');
      const group = { id: this.editId || requestId(), name, members: members.map(({ id, name, username }) => ({ id, name, username })) };
      const groups = this.editId ? this.groups.map((g) => g.id === this.editId ? group : g) : [...this.groups, group];
      this.persistGroups(groups); this.selected = group.id; this.requestId = requestId();
      this.refs.expected.checked = false; this.refs.editor.close(); this.renderGroups(); this.renderControls();
    } catch (err) { this.refs.editorError.textContent = err.message; }
  }
  render() {
    const signedIn = Boolean(this.data);
    this.refs.loginPanel.hidden = signedIn; this.refs.workspace.hidden = !signedIn; this.refs.logout.hidden = !signedIn;
    this.refs.account.textContent = signedIn ? `Подключён аккаунт: ${this.data.user.name}${this.data.user.username ? ` (@${this.data.user.username})` : ''}` : '';
    this.renderGroups(); this.renderJobs(); this.renderControls();
  }
  renderGroups() {
    this.refs.groups.innerHTML = this.groups.map((g) => `<button class="student-item ${g.id === this.selected ? 'active' : ''}" data-group="${esc(g.id)}">${esc(g.name)} <span class="small-muted">· ${g.members.length}</span></button>`).join('') || '<p class="small-muted">Пока нет групп.</p>';
    const group = this.group(); this.refs.empty.hidden = Boolean(group); this.refs.composer.hidden = !group;
    if (group) {
      this.refs.groupTitle.textContent = group.name;
      this.refs.members.innerHTML = group.members.map((m) => `<span class="badge text-bg-light border fw-normal">${esc(m.name)}</span>`).join('') || '<span class="small-muted">В группе пока нет контактов.</span>';
      this.refs.pace.textContent = `Сообщения отправляются по одному с интервалом не менее ${Math.round((this.data?.intervalMs || 30000) / 1000)} сек. Это снижает скорость отправки, но не гарантирует защиту от блокировки.`;
    }
    this.renderControls();
  }
  renderControls() {
    const active = this.data?.jobs.some((j) => ['running', 'waiting', 'paused'].includes(j.status));
    const count = this.group()?.members.length || 0;
    this.refs.send.textContent = this.busy ? 'Подождите…' : `Отправить ${count} получателям`;
    this.refs.send.disabled = Boolean(this.busy || active || this.data?.restricted || !count || !this.refs.message.value.trim() || !this.refs.expected.checked || this.data?.nextSendAt > Date.now());
    this.refs.loginSubmit.disabled = Boolean(this.busy || !this.configured);
    this.refs.loginSubmit.textContent = this.busy ? 'Подождите…' : this.needsPassword ? 'Войти' : this.loginToken ? 'Подтвердить код' : 'Получить код';
    this.refs.restart.disabled = Boolean(this.busy);
    for (const name of ['newGroup', 'editGroup', 'deleteGroup', 'logout', 'acknowledge']) this.refs[name].disabled = Boolean(this.busy);
    this.refs.message.disabled = Boolean(this.busy);
    this.refs.expected.disabled = Boolean(this.busy);
  }
  renderJobs() {
    this.refs.restriction.hidden = !this.data?.restricted;
    if (!this.data) { this.refs.jobs.innerHTML = ''; this.lastJobsHtml = ''; return; }
    const html = [...this.data.jobs].reverse().map((job) => {
      const sent = job.recipients.filter((r) => r.status === 'sent').length;
      const pending = job.recipients.some((r) => r.status === 'pending');
      const controllable = ['running', 'waiting', 'paused'].includes(job.status);
      return `<div class="border rounded p-3 mt-2"><div class="d-flex justify-content-between gap-2 flex-wrap"><strong>${esc(job.groupName)}</strong><span>${esc(labels[job.status] || job.status)} · ${sent} / ${job.recipients.length} отправлено</span></div>
        <div class="small-muted">${esc(new Date(job.createdAt).toLocaleString('ru'))}</div><p class="tg-message mt-2 mb-2">${esc(job.message)}</p>
        ${job.note ? `<p class="small text-warning-emphasis">${esc(job.note)}</p>` : ''}
        ${controllable && this.data.nextSendAt > Date.now() ? `<p class="small-muted">Следующая отправка не ранее ${esc(new Date(this.data.nextSendAt).toLocaleTimeString('ru'))}</p>` : ''}
        <details data-details="${esc(job.id)}"><summary class="small">Получатели и результаты</summary><ul class="small mt-2">${job.recipients.map((r) => `<li>${esc(r.name)} — ${esc(labels[r.status] || r.status)}${r.error ? ` (${esc(r.error)})` : ''}</li>`).join('')}</ul></details>
        ${controllable ? `<button class="btn btn-sm btn-outline-danger mt-2" data-action="stop" data-job="${esc(job.id)}">Остановить</button>` : ''}
        ${job.status === 'paused' && pending && !this.data.restricted ? `<button class="btn btn-sm btn-outline-primary mt-2 ms-2" data-action="resume" data-job="${esc(job.id)}" ${this.data.nextSendAt > Date.now() ? 'disabled' : ''}>Продолжить оставшиеся</button>` : ''}</div>`;
    }).join('') || '<p class="small-muted mb-0">Отправленных рассылок пока нет.</p>';
    if (html !== this.lastJobsHtml) {
      const opened = new Set([...this.refs.jobs.querySelectorAll('details[open]')].map((el) => el.dataset.details));
      this.refs.jobs.innerHTML = html; this.lastJobsHtml = html;
      for (const el of this.refs.jobs.querySelectorAll('details')) el.open = opened.has(el.dataset.details);
    }
  }
}
