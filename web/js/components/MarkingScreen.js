import { escapeHtml } from '../utils.js';

export class MarkingScreen {
  constructor(refs, state, callbacks) {
    this.refs = refs;
    this.state = state;
    this.callbacks = callbacks;
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
    this.refs.previewBtn.addEventListener('click', async () => {
      try {
        this.refs.markingStatus.textContent = 'Готовим предпросмотр...';
        this.refs.applyBtn.disabled = true;
        const preview = await this.callbacks.preview({
          groupId: this.refs.groupSelect.value,
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
  }
}
