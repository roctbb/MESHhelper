import { escapeHtml } from '../utils.js';

export class MarkingScreen {
  constructor(refs, state, callbacks) {
    this.refs = refs;
    this.state = state;
    this.callbacks = callbacks;
    this.previewVersion = 0;
    this.groupLoadVersion = 0;
  }

  invalidatePreview() {
    this.previewVersion += 1;
    this.state.marking.preview = null;
    this.refs.applyBtn.disabled = true;
    this.refs.markingStatus.textContent = 'Предпросмотр устарел: данные изменены.';
    this.renderPreviewRows([]);
  }

  statusBadge(status) {
    if (status === 'ready' || status === 'created') return 'text-bg-success';
    if (String(status).startsWith('skip')) return 'text-bg-secondary';
    return 'text-bg-danger';
  }

  renderGroups() {
    this.refs.groupSelect.innerHTML = '';
    this.state.marking.groups.forEach((g) => {
      const opt = document.createElement('option');
      opt.value = String(g.id);
      opt.textContent = `${g.name} (${g.studentCount})`;
      this.refs.groupSelect.appendChild(opt);
    });
    if (!this.state.marking.groups.length) {
      this.refs.groupSelect.innerHTML = '<option value="">Нет групп</option>';
    }
  }

  renderControlForms() {
    const previousValue = String(this.state.marking.selectedControlFormId || this.refs.controlFormSelect.value || '');
    const previousLabel = String(this.state.marking.selectedControlFormLabel || '').trim();
    this.refs.controlFormSelect.innerHTML = '';
    const forms = this.state.marking.controlForms || [];
    forms.forEach((f) => {
      const opt = document.createElement('option');
      opt.value = String(f.id);
      opt.textContent = f.label || f.name || `Форма ${f.id}`;
      this.refs.controlFormSelect.appendChild(opt);
    });
    if (!forms.length) {
      this.refs.controlFormSelect.innerHTML = '<option value="">Нет доступных форм</option>';
      this.state.marking.selectedControlFormId = '';
      this.state.marking.selectedControlFormLabel = '';
      return;
    }

    const byId = previousValue && forms.find((f) => String(f.id) === previousValue);
    const byLabel = previousLabel && forms.find((f) => String(f.label || f.name || `Форма ${f.id}`).trim() === previousLabel);
    const selected = byId || byLabel || forms[0];
    this.refs.controlFormSelect.value = String(selected.id);
    this.state.marking.selectedControlFormId = String(selected.id);
    this.state.marking.selectedControlFormLabel = String(selected.label || selected.name || `Форма ${selected.id}`);
  }

  async loadControlFormsForSelectedGroup() {
    const version = ++this.groupLoadVersion;
    const groupId = this.refs.groupSelect.value;
    const comment = this.refs.commentInput.value;
    const selectedOption = this.refs.controlFormSelect.selectedOptions?.[0] || null;
    this.state.marking.selectedControlFormId = String(this.refs.controlFormSelect.value || this.state.marking.selectedControlFormId || '');
    this.state.marking.selectedControlFormLabel = String(selectedOption?.textContent || this.state.marking.selectedControlFormLabel || '');
    this.state.marking.comment = comment;
    this.invalidatePreview();
    this.refs.previewBtn.disabled = true;
    this.refs.markingLessonDate.disabled = true;
    this.refs.markingLessonDate.innerHTML = '<option value="">Загрузка...</option>';
    this.refs.controlFormSelect.innerHTML = '<option value="">Загрузка...</option>';
    if (!groupId) {
      this.state.marking.controlForms = [];
      this.renderControlForms();
      this.refs.markingLessonDate.innerHTML = '<option value="">Нет доступных дат</option>';
      this.refs.commentInput.value = comment;
      return;
    }
    this.refs.markingStatus.textContent = 'Загружаем формы оценивания и даты уроков...';
    let data;
    try {
      data = await this.callbacks.loadControlForms(groupId);
    } catch (err) {
      if (version !== this.groupLoadVersion) return;
      this.refs.markingLessonDate.innerHTML = '<option value="">Не удалось загрузить даты</option>';
      throw err;
    }
    if (version !== this.groupLoadVersion) return;
    this.state.marking.controlForms = data.controlForms;
    this.state.marking.controlFormsGroupId = String(groupId);
    this.refs.markingLessonDate.innerHTML = '<option value="">Последний доступный</option>';
    data.lessonDates.forEach((date) => {
      const option = document.createElement('option');
      option.value = date;
      option.textContent = date.split('-').reverse().join('.');
      this.refs.markingLessonDate.appendChild(option);
    });
    this.refs.markingLessonDate.value = '';
    this.refs.markingLessonDate.disabled = false;
    this.refs.previewBtn.disabled = false;
    this.renderControlForms();
    this.refs.commentInput.value = comment;
    this.refs.markingStatus.textContent = '';
  }

  renderPreviewRows(rows) {
    this.refs.previewTableBody.innerHTML = '';
    if (!rows.length) {
      this.refs.previewTableBody.innerHTML = '<tr><td colspan="6" class="text-secondary p-3">Нет строк</td></tr>';
      return;
    }
    rows.forEach((r) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${r.line || ''}</td>
        <td>${escapeHtml(r.inputName || '')}</td>
        <td>${escapeHtml(r.studentName || '—')}</td>
        <td>${Number.isFinite(Number(r.grade)) ? Number(r.grade) : '—'}</td>
        <td><span class="badge ${this.statusBadge(r.status)}">${escapeHtml(r.status || '')}</span></td>
        <td>${escapeHtml(r.reason || '')}</td>
      `;
      this.refs.previewTableBody.appendChild(tr);
    });
  }

  bind() {
    this.refs.markingLessonDate.addEventListener('change', () => this.invalidatePreview());

    this.refs.groupSelect.addEventListener('change', () => {
      this.loadControlFormsForSelectedGroup().catch((err) => {
        this.state.marking.controlForms = [];
        this.renderControlForms();
        this.refs.commentInput.value = String(this.state.marking.comment || '');
        this.refs.markingStatus.textContent = `Ошибка: ${err.message}`;
      });
    });

    this.refs.controlFormSelect.addEventListener('change', () => {
      this.invalidatePreview();
      const selectedOption = this.refs.controlFormSelect.selectedOptions?.[0] || null;
      this.state.marking.selectedControlFormId = String(this.refs.controlFormSelect.value || '');
      this.state.marking.selectedControlFormLabel = String(selectedOption?.textContent || '');
    });

    this.refs.commentInput.addEventListener('input', () => {
      this.invalidatePreview();
      this.state.marking.comment = this.refs.commentInput.value;
    });

    [this.refs.namesInput, this.refs.gradesInput].forEach((input) => {
      input.addEventListener('input', () => this.invalidatePreview());
    });

    this.refs.previewBtn.addEventListener('click', async () => {
      this.invalidatePreview();
      const version = this.previewVersion;
      try {
        this.refs.markingStatus.textContent = 'Готовим предпросмотр...';
        this.refs.applyBtn.disabled = true;
        const lessonDate = this.refs.markingLessonDate.value;
        const preview = await this.callbacks.preview({
          groupId: this.refs.groupSelect.value,
          controlFormId: this.refs.controlFormSelect.value,
          lessonDate,
          namesText: this.refs.namesInput.value,
          marksText: this.refs.gradesInput.value,
          comment: this.refs.commentInput.value
        });
        if (version !== this.previewVersion) return;
        this.state.marking.preview = preview;
        this.renderPreviewRows(preview.rows || []);

        const s = preview.summary || {};
        const lessonDateLabel = new Date(preview.lesson.isoDateTime).toLocaleString('ru-RU', {
          timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short'
        });
        this.refs.markingStatus.textContent = `Урок: ${lessonDateLabel}, ${preview.lesson.lessonName || 'без темы'}. Форма: ${preview.controlForm.name}. Готово: ${s.ready || 0}, пропуски: ${(s.skipNotInGroup || 0) + (s.skipEmpty || 0)}, ошибки: ${s.errors || 0}`;
        this.refs.applyBtn.disabled = Number(s.ready || 0) <= 0 || Number(s.errors || 0) > 0;
      } catch (err) {
        if (version !== this.previewVersion) return;
        this.refs.markingStatus.textContent = `Ошибка: ${err.message}`;
        this.state.marking.preview = null;
        this.refs.applyBtn.disabled = true;
      }
    });

    this.refs.applyBtn.addEventListener('click', async () => {
      if (!this.state.marking.preview) return;
      try {
        this.refs.markingStatus.textContent = 'Отправляем отметки...';
        const results = await this.callbacks.apply(this.state.marking.preview);
        this.renderPreviewRows(results);
        const summary = {
          created: results.filter((x) => x.status === 'created').length,
          skipped: results.filter((x) => String(x.status).startsWith('skip')).length,
          errors: results.filter((x) => x.status === 'error').length
        };
        this.refs.markingStatus.textContent = `Создано: ${summary.created}, пропущено: ${summary.skipped}, ошибок: ${summary.errors}`;
        this.refs.applyBtn.disabled = true;
      } catch (err) {
        this.refs.markingStatus.textContent = `Ошибка: ${err.message}`;
      }
    });

  }
}
