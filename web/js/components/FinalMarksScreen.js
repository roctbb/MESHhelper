import { escapeHtml } from '../utils.js';

export class FinalMarksScreen {
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

  renderGroupOptions() {
    this.refs.finalGroupSelect.innerHTML = '';
    const options = this.state.finalMarks.groups || [];
    options.forEach((g) => {
      const opt = document.createElement('option');
      opt.value = String(g.id);
      const subject = g.subjectName || g.name || `Группа ${g.id}`;
      const className = g.classUnitName || '';
      opt.textContent = className ? `${subject} ${className}` : subject;
      this.refs.finalGroupSelect.appendChild(opt);
    });

    if (!options.length) {
      this.refs.finalGroupSelect.innerHTML = '<option value="">Нет групп</option>';
      return;
    }

    const selected = this.state.finalMarks.selectedGroupId || String(options[0].id);
    this.refs.finalGroupSelect.value = options.some((x) => String(x.id) === selected) ? selected : String(options[0].id);
    this.state.finalMarks.selectedGroupId = this.refs.finalGroupSelect.value;
  }

  selectedPeriodTypes() {
    const trimesters = [
      [this.refs.finalT1Check, this.state.config.trimesterBoundaries?.[0]?.label || '1 триместр'],
      [this.refs.finalT2Check, this.state.config.trimesterBoundaries?.[1]?.label || '2 триместр'],
      [this.refs.finalT3Check, this.state.config.trimesterBoundaries?.[2]?.label || '3 триместр']
    ].filter(([el]) => Boolean(el?.checked)).map(([, label]) => label);

    return {
      trimesters,
      intermediate: Boolean(this.refs.finalIntermediateCheck?.checked),
      year: Boolean(this.refs.finalYearCheck?.checked)
    };
  }

  renderPreviewRows(rows) {
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

  updateApplyState() {
    const rows = this.state.finalMarks.preview?.rows || [];
    this.refs.finalApplyBtn.disabled = !rows.some((row) => row.status === 'ready');
  }

  resetPreview() {
    this.state.finalMarks.preview = null;
    this.refs.finalPreviewTableBody.innerHTML = '<tr><td colspan="8" class="text-secondary p-3">Сделайте предпросмотр.</td></tr>';
    this.refs.finalMarkingStatus.textContent = '';
    this.refs.finalApplyBtn.disabled = true;
  }

  bind() {
    this.refs.finalGroupSelect.addEventListener('change', () => {
      this.state.finalMarks.selectedGroupId = String(this.refs.finalGroupSelect.value || '');
      this.resetPreview();
    });

    [
      this.refs.finalT1Check,
      this.refs.finalT2Check,
      this.refs.finalT3Check,
      this.refs.finalIntermediateCheck,
      this.refs.finalYearCheck
    ].forEach((el) => {
      el?.addEventListener('change', () => this.resetPreview());
    });

    this.refs.finalPreviewBtn.addEventListener('click', async () => {
      try {
        this.refs.finalMarkingStatus.textContent = 'Готовим предпросмотр итоговых...';
        this.refs.finalApplyBtn.disabled = true;
        const preview = await this.callbacks.preview({
          groupId: this.refs.finalGroupSelect.value,
          selectedPeriodTypes: this.selectedPeriodTypes()
        });
        this.state.finalMarks.preview = preview;
        this.renderPreviewRows(preview.rows || []);

        const s = preview.summary || {};
        this.refs.finalMarkingStatus.textContent = `К изменению: ${s.ready || 0}, уже совпадают: ${s.same || 0}, пропуски: ${s.skipped || 0}, ошибки: ${s.errors || 0}`;
        this.updateApplyState();
      } catch (err) {
        this.refs.finalMarkingStatus.textContent = `Ошибка: ${err.message}`;
        this.state.finalMarks.preview = null;
        this.refs.finalApplyBtn.disabled = true;
      }
    });

    this.refs.finalApplyBtn.addEventListener('click', async () => {
      if (!this.state.finalMarks.preview) return;
      try {
        this.refs.finalMarkingStatus.textContent = 'Отправляем итоговые отметки...';
        this.refs.finalApplyBtn.disabled = true;
        const results = await this.callbacks.apply(this.state.finalMarks.preview);
        this.state.finalMarks.preview = { ...this.state.finalMarks.preview, rows: results };
        this.renderPreviewRows(results);
        const summary = {
          created: results.filter((x) => x.status === 'created').length,
          skipped: results.filter((x) => String(x.status).startsWith('skip')).length,
          errors: results.filter((x) => x.status === 'error').length
        };
        this.refs.finalMarkingStatus.textContent = `Создано: ${summary.created}, пропущено: ${summary.skipped}, ошибок: ${summary.errors}`;
      } catch (err) {
        this.refs.finalMarkingStatus.textContent = `Ошибка: ${err.message}`;
        this.updateApplyState();
      }
    });
  }
}
