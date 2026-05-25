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
      opt.textContent = `${g.name || g.subjectName || `Группа ${g.id}`} (${g.studentCount || 0})`;
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

  selectedPeriodLabels() {
    const selected = this.selectedPeriodTypes();
    const labels = [...selected.trimesters];
    if (selected.intermediate) labels.push('Промежуточная аттестация');
    if (selected.year) labels.push('Год');
    return labels;
  }

  rowKey(row) {
    return `${row.studentProfileId || row.studentName}|${row.subjectId || row.subject}`;
  }

  renderPreviewCell(row) {
    if (!row) return '<span class="text-secondary">—</span>';

    const avg = Number.isFinite(Number(row.calculatedAverage)) ? `ср. ${Number(row.calculatedAverage).toFixed(2)}` : '';
    const existing = Number.isFinite(Number(row.existingGrade)) ? `было ${Math.round(Number(row.existingGrade))}` : 'не было';
    const desired = Number.isFinite(Number(row.desiredGrade)) ? Math.round(Number(row.desiredGrade)) : '—';
    const details = [existing, avg, row.reason || ''].filter(Boolean).join(' · ');
    return `
      <div class="d-flex align-items-center justify-content-center gap-1">
        <span class="fw-bold">${desired}</span>
        <span class="badge ${this.statusBadge(row.status)}">${escapeHtml(row.status || '')}</span>
      </div>
      <div class="small-muted text-center">${escapeHtml(details)}</div>
    `;
  }

  renderPreviewRows(rows) {
    const labels = this.selectedPeriodLabels();
    const colCount = 2 + labels.length;
    this.refs.finalPreviewTableHead.innerHTML = `
      <tr>
        <th>Ученик</th>
        <th>Предмет</th>
        ${labels.map((label) => `<th class="text-center">${escapeHtml(label)}</th>`).join('')}
      </tr>
    `;
    this.refs.finalPreviewTableBody.innerHTML = '';
    if (!rows.length) {
      this.refs.finalPreviewTableBody.innerHTML = `<tr><td colspan="${colCount}" class="text-secondary p-3">Нет строк</td></tr>`;
      return;
    }

    const grouped = new Map();
    rows.forEach((row) => {
      const key = this.rowKey(row);
      if (!grouped.has(key)) {
        grouped.set(key, {
          studentName: row.studentName,
          subject: row.subject,
          byPeriod: new Map()
        });
      }
      grouped.get(key).byPeriod.set(row.periodLabel, row);
    });

    [...grouped.values()].forEach((r) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(r.studentName || '—')}</td>
        <td>${escapeHtml(r.subject || '—')}</td>
        ${labels.map((label) => `<td class="text-center">${this.renderPreviewCell(r.byPeriod.get(label))}</td>`).join('')}
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
    this.refs.finalPreviewTableHead.innerHTML = '<tr><th>Ученик</th><th>Предмет</th><th class="text-center">Отметки</th></tr>';
    this.refs.finalPreviewTableBody.innerHTML = '<tr><td colspan="3" class="text-secondary p-3">Сделайте предпросмотр.</td></tr>';
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
