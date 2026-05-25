import { escapeHtml } from '../utils.js';

export class MarkingScreen {
  constructor(refs, state, callbacks) {
    this.refs = refs;
    this.state = state;
    this.callbacks = callbacks;
  }

  statusBadge(status) {
    if (status === 'ready' || status === 'created') return 'text-bg-success';
    if (status === 'skip_same') return 'text-bg-primary';
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
    const groupId = this.refs.groupSelect.value;
    const comment = this.refs.commentInput.value;
    const selectedOption = this.refs.controlFormSelect.selectedOptions?.[0] || null;
    this.state.marking.selectedControlFormId = String(this.refs.controlFormSelect.value || this.state.marking.selectedControlFormId || '');
    this.state.marking.selectedControlFormLabel = String(selectedOption?.textContent || this.state.marking.selectedControlFormLabel || '');
    this.state.marking.comment = comment;
    this.state.marking.preview = null;
    this.refs.applyBtn.disabled = true;
    this.refs.controlFormSelect.innerHTML = '<option value="">Загрузка...</option>';
    if (!groupId) {
      this.state.marking.controlForms = [];
      this.renderControlForms();
      this.refs.commentInput.value = comment;
      return;
    }
    this.refs.markingStatus.textContent = 'Загружаем формы оценивания...';
    await this.callbacks.loadControlForms(groupId);
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

  renderFinalPreviewRows(rows) {
    this.refs.finalPreviewTableBody.innerHTML = '';
    if (!rows.length) {
      this.refs.finalPreviewTableBody.innerHTML = '<tr><td colspan="8" class="text-secondary p-3">Нет строк</td></tr>';
      return;
    }

    rows.forEach((r) => {
      const tr = document.createElement('tr');
      const avg = Number.isFinite(Number(r.calculatedAverage)) ? Number(r.calculatedAverage).toFixed(2) : '—';
      const existing = Number.isFinite(Number(r.existingGrade)) ? Math.round(Number(r.existingGrade)) : '—';
      const desired = Number.isFinite(Number(r.desiredGrade)) ? Math.round(Number(r.desiredGrade)) : '—';
      tr.innerHTML = `
        <td>${r.line || ''}</td>
        <td>${escapeHtml(r.studentName || '—')}</td>
        <td>${escapeHtml(r.subject || '—')}</td>
        <td>${escapeHtml(r.periodLabel || '—')}</td>
        <td class="text-center">${avg}</td>
        <td class="text-center">${existing}</td>
        <td class="text-center">${desired}</td>
        <td><span class="badge ${this.statusBadge(r.status)}">${escapeHtml(r.status || '')}</span> ${escapeHtml(r.reason || '')}</td>
      `;
      this.refs.finalPreviewTableBody.appendChild(tr);
    });
  }

  updateFinalApplyState() {
    const rows = this.state.marking.finalPreview?.rows || [];
    this.refs.finalApplyBtn.disabled = !rows.some((row) => row.status === 'ready');
  }

  bind() {
    this.refs.groupSelect.addEventListener('change', () => {
      this.loadControlFormsForSelectedGroup().catch((err) => {
        this.state.marking.controlForms = [];
        this.renderControlForms();
        this.refs.commentInput.value = String(this.state.marking.comment || '');
        this.refs.markingStatus.textContent = `Ошибка: ${err.message}`;
      });
    });

    this.refs.controlFormSelect.addEventListener('change', () => {
      const selectedOption = this.refs.controlFormSelect.selectedOptions?.[0] || null;
      this.state.marking.selectedControlFormId = String(this.refs.controlFormSelect.value || '');
      this.state.marking.selectedControlFormLabel = String(selectedOption?.textContent || '');
    });

    this.refs.commentInput.addEventListener('input', () => {
      this.state.marking.comment = this.refs.commentInput.value;
    });

    this.refs.previewBtn.addEventListener('click', async () => {
      try {
        this.refs.markingStatus.textContent = 'Готовим предпросмотр...';
        this.refs.applyBtn.disabled = true;
        const preview = await this.callbacks.preview({
          groupId: this.refs.groupSelect.value,
          controlFormId: this.refs.controlFormSelect.value,
          namesText: this.refs.namesInput.value,
          marksText: this.refs.gradesInput.value,
          comment: this.refs.commentInput.value
        });
        this.state.marking.preview = preview;
        this.renderPreviewRows(preview.rows || []);

        const s = preview.summary || {};
        this.refs.markingStatus.textContent = `Готово: ${s.ready || 0}, пропуски: ${(s.skipNotInGroup || 0) + (s.skipEmpty || 0)}, ошибки: ${s.errors || 0}`;
        this.refs.applyBtn.disabled = Number(s.ready || 0) <= 0 || Number(s.errors || 0) > 0;
      } catch (err) {
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

    this.refs.finalPreviewBtn.addEventListener('click', async () => {
      try {
        this.refs.finalMarkingStatus.textContent = 'Готовим предпросмотр итоговых...';
        this.refs.finalApplyBtn.disabled = true;
        const preview = await this.callbacks.previewFinals();
        this.state.marking.finalPreview = preview;
        this.renderFinalPreviewRows(preview.rows || []);

        const s = preview.summary || {};
        this.refs.finalMarkingStatus.textContent = `К изменению: ${s.ready || 0}, уже совпадают: ${s.same || 0}, пропуски: ${s.skipped || 0}, ошибки: ${s.errors || 0}`;
        this.updateFinalApplyState();
      } catch (err) {
        this.refs.finalMarkingStatus.textContent = `Ошибка: ${err.message}`;
        this.state.marking.finalPreview = null;
        this.refs.finalApplyBtn.disabled = true;
      }
    });

    this.refs.finalApplyBtn.addEventListener('click', async () => {
      if (!this.state.marking.finalPreview) return;
      try {
        this.refs.finalMarkingStatus.textContent = 'Отправляем итоговые отметки...';
        this.refs.finalApplyBtn.disabled = true;
        const results = await this.callbacks.applyFinals(this.state.marking.finalPreview);
        this.state.marking.finalPreview = { ...this.state.marking.finalPreview, rows: results };
        this.renderFinalPreviewRows(results);
        const summary = {
          created: results.filter((x) => x.status === 'created').length,
          skipped: results.filter((x) => String(x.status).startsWith('skip')).length,
          errors: results.filter((x) => x.status === 'error').length
        };
        this.refs.finalMarkingStatus.textContent = `Создано: ${summary.created}, пропущено: ${summary.skipped}, ошибок: ${summary.errors}`;
      } catch (err) {
        this.refs.finalMarkingStatus.textContent = `Ошибка: ${err.message}`;
        this.updateFinalApplyState();
      }
    });
  }
}
