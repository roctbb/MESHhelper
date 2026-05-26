import { escapeHtml } from '../utils.js';

export class SoftSkillsScreen {
  constructor(refs, state, callbacks) {
    this.refs = refs;
    this.state = state;
    this.callbacks = callbacks;
  }

  statusBadge(status) {
    if (status === 'created' || status === 'updated') return 'text-bg-success';
    if (String(status).startsWith('skip')) return 'text-bg-secondary';
    if (status === 'pending') return 'text-bg-primary';
    return 'text-bg-danger';
  }

  renderRows(rows) {
    this.refs.skillsTableBody.innerHTML = '';
    if (!rows.length) {
      this.refs.skillsTableBody.innerHTML = '<tr><td colspan="6" class="text-secondary p-3">Запустите заполнение.</td></tr>';
      return;
    }

    rows.forEach((row, idx) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${idx + 1}</td>
        <td>${escapeHtml(row.studentName || '—')}</td>
        <td>${escapeHtml(row.groupName || '—')}</td>
        <td class="text-center">${Number.isFinite(Number(row.classLevelId)) ? Number(row.classLevelId) : '—'}</td>
        <td><span class="badge ${this.statusBadge(row.status)}">${escapeHtml(row.status || '')}</span></td>
        <td>${escapeHtml(row.reason || (Number(row.answersCount) ? `Ответов: ${row.answersCount}` : ''))}</td>
      `;
      this.refs.skillsTableBody.appendChild(tr);
    });
  }

  bind() {
    this.refs.skillsRunBtn.addEventListener('click', async () => {
      try {
        this.refs.skillsRunBtn.disabled = true;
        this.refs.skillsStatus.textContent = 'Готовим список учеников...';
        this.renderRows([]);

        const result = await this.callbacks.run({
          statusCb: (text) => {
            this.refs.skillsStatus.textContent = text;
          }
        });

        this.state.softSkills.result = result;
        this.renderRows(result.rows || []);
        const s = result.summary || {};
        this.refs.skillsStatus.textContent = `Создано: ${s.created || 0}, обновлено: ${s.updated || 0}, пропущено: ${s.skipped || 0}, ошибок: ${s.errors || 0}`;
      } catch (err) {
        this.refs.skillsStatus.textContent = `Ошибка: ${err.message}`;
      } finally {
        this.refs.skillsRunBtn.disabled = false;
      }
    });
  }
}
