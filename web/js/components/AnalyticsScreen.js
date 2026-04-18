import { badgeClass, escapeHtml, normalizeName } from '../utils.js';
import { buildSubjectRows } from '../engines/analytics.js';

export class AnalyticsScreen {
  constructor(refs, state, storage, callbacks) {
    this.refs = refs;
    this.state = state;
    this.storage = storage;
    this.callbacks = callbacks;
  }

  avgBadge(v) {
    if (!Number.isFinite(v)) return '<span class="badge text-bg-secondary">—</span>';
    return `<span class="badge ${badgeClass(v)}">${v.toFixed(2)}</span>`;
  }

  rowClassByYearAvg(v) {
    if (!Number.isFinite(v)) return '';
    if (v < 5) return 'table-danger';
    if (v < 7) return 'table-warning';
    return '';
  }

  isHidden(name) {
    return this.state.hiddenStudents.has(normalizeName(name));
  }

  filterAndSortStudents() {
    const needle = normalizeName(this.state.ui.search || '');
    let items = [...this.state.analytics.studentCards];
    if (!this.state.ui.showHiddenStudents) items = items.filter((x) => !this.isHidden(x.name));
    if (needle) items = items.filter((x) => normalizeName(x.name).includes(needle));

    const mode = this.state.ui.sort;
    if (mode === 'name_asc') items.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    else if (mode === 'name_desc') items.sort((a, b) => b.name.localeCompare(a.name, 'ru'));
    else if (mode === 'avg_asc') items.sort((a, b) => (a.averageGrade ?? Infinity) - (b.averageGrade ?? Infinity));
    else items.sort((a, b) => (b.averageGrade ?? -Infinity) - (a.averageGrade ?? -Infinity));

    return items;
  }

  renderClassFilter() {
    this.refs.classFilter.innerHTML = '';
    const optAll = document.createElement('option');
    optAll.value = '__all__';
    optAll.textContent = 'Все классы';
    this.refs.classFilter.appendChild(optAll);

    (this.state.analytics.classOptions || []).forEach((c) => {
      const opt = document.createElement('option');
      opt.value = String(c.id);
      opt.textContent = c.name;
      this.refs.classFilter.appendChild(opt);
    });

    this.refs.classFilter.value = this.state.analytics.selectedClassUnitId || '__all__';
    const envClassUnitIds = Array.isArray(this.state.config.analyticsClassUnitIds)
      ? this.state.config.analyticsClassUnitIds.map((x) => Number(x)).filter(Number.isFinite)
      : [];
    this.refs.classFilter.disabled = envClassUnitIds.length > 0;
    this.refs.classFilter.title = envClassUnitIds.length > 0
      ? `Фиксировано через API_CLASS_UNIT_IDS: ${envClassUnitIds.join(',')}`
      : '';
  }

  renderStudentsList() {
    const items = this.filterAndSortStudents();
    this.refs.studentsList.innerHTML = '';
    if (this.refs.goSummaryBtn) {
      this.refs.goSummaryBtn.className = `btn btn-sm w-100 ${this.state.analytics.selectedStudent ? 'btn-outline-primary' : 'btn-primary'}`;
    }

    items.forEach((s) => {
      const keyRiskSubjects = Array.isArray(s.yearRiskSubjects) ? s.yearRiskSubjects : [];
      const hasKeyRisk = keyRiskSubjects.some((subj) => /(алгебр|геометр|математ|информат)/i.test(String(subj)));
      const btn = document.createElement('button');
      const isExcellent = Boolean(s.excellentAllSubjects);
      btn.className = `student-item${s.name === this.state.analytics.selectedStudent ? ' active' : ''}${hasKeyRisk ? ' year-risk-key' : ''}${isExcellent ? ' excellent' : ''}`;
      btn.onclick = () => this.callbacks.openStudent(s.name);

      const currentTitle = s.currentTrimesterRiskSubjects.length
        ? `Риски ${this.state.analytics.currentTrimester}: ${s.currentTrimesterRiskSubjects.join(', ')}`
        : `Риски ${this.state.analytics.currentTrimester}`;
      const yearTitle = s.yearRiskSubjects.length
        ? `Риск годовой тройки: ${s.yearRiskSubjects.join(', ')}`
        : 'Риск годовой тройки';

      const hidden = this.isHidden(s.name);
      const hideLabel = hidden ? 'Показать ученика' : 'Скрыть ученика';
      const hideBtnClass = hidden ? 'btn-outline-success' : 'btn-outline-secondary';
      const trendIcon = s.averageTrend === 'up'
        ? '<span style=\"color:#198754\" title=\"Успеваемость растёт по большинству предметов\">▲</span> '
        : s.averageTrend === 'down'
          ? '<span style=\"color:#dc3545\" title=\"Успеваемость снижается по большинству предметов\">▼</span> '
          : '';
      const strongUpTitle = s.strongTrendUpSubjects?.length
        ? `Сильный рост: ${s.strongTrendUpSubjects.join(', ')}`
        : 'Сильный рост по предметам';
      const strongDownTitle = s.strongTrendDownSubjects?.length
        ? `Сильное снижение: ${s.strongTrendDownSubjects.join(', ')}`
        : 'Сильное снижение по предметам';
      const pointsTitle = s.pointSubjects?.length
        ? `Есть точки: ${s.pointSubjects.join(', ')}`
        : 'Есть точки (оценки, которые можно исправить)';

      btn.innerHTML = `
        <div class="d-flex justify-content-between align-items-center gap-2">
          <span style="min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap">${trendIcon}${escapeHtml(s.name)}</span>
          <span class="d-inline-flex align-items-center gap-1">
            ${hidden ? '<span class="badge text-bg-secondary">Скрыт</span>' : ''}
            ${this.avgBadge(s.averageGrade)}
            ${s.strongTrendUp ? `<span class="badge text-bg-success" title="${escapeHtml(strongUpTitle)}">↑↑</span>` : ''}
            ${s.strongTrendDown ? `<span class="badge text-bg-danger" title="${escapeHtml(strongDownTitle)}">↓↓</span>` : ''}
            ${s.hasPoints ? `<span class="badge text-bg-info" title="${escapeHtml(pointsTitle)}">•</span>` : ''}
            ${s.warningCurrentTrimester ? `<span class="badge text-bg-warning" title="${escapeHtml(currentTitle)}">!</span>` : ''}
            ${s.warningYear ? `<span class="badge text-bg-danger" title="${escapeHtml(yearTitle)}">!</span>` : ''}
            <button class="btn btn-sm ${hideBtnClass} js-hide-student" title="${hideLabel}" aria-label="${hideLabel}" style="line-height:1;padding:1px 6px">👁</button>
          </span>
        </div>
      `;

      const hideBtn = btn.querySelector('.js-hide-student');
      hideBtn?.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this.callbacks.toggleHidden(s.name);
      });

      this.refs.studentsList.appendChild(btn);
    });

    if (!items.length) this.refs.studentsList.innerHTML = '<div class="small text-secondary p-2">Нет результатов.</div>';
    const hiddenCount = this.state.analytics.studentCards.filter((x) => this.isHidden(x.name)).length;
    this.refs.studentsMeta.textContent = `Учеников: ${this.state.analytics.studentCards.length}, скрыто: ${hiddenCount}, показано: ${items.length}`;
  }

  renderProblemCards() {
    if (this.state.analytics.selectedStudent) {
      this.refs.problemBlock.style.display = 'none';
      this.refs.trendBlock.style.display = 'none';
      this.refs.pointsBlock.style.display = 'none';
      return;
    }
    this.refs.problemBlock.style.display = '';
    this.refs.trendBlock.style.display = '';
    this.refs.pointsBlock.style.display = '';

    const pool = [...this.state.analytics.studentCards]
      .filter((s) => this.state.ui.showHiddenStudents || !this.isHidden(s.name))
      .filter((s) => s.warningYear || s.warningCurrentTrimester || s.averageTrend === 'down' || (Number.isFinite(s.averageGrade) && s.averageGrade < 7))
      .sort((a, b) => {
        const aw = (a.warningYear ? 2 : 0) + (a.warningCurrentTrimester ? 1 : 0);
        const bw = (b.warningYear ? 2 : 0) + (b.warningCurrentTrimester ? 1 : 0);
        if (bw !== aw) return bw - aw;
        return (a.averageGrade ?? 99) - (b.averageGrade ?? 99);
      })
      .slice(0, 12);

    this.refs.problemGrid.innerHTML = '';
    this.refs.problemMeta.textContent = pool.length ? `Найдено: ${pool.length}` : 'Рисков не найдено';

    if (!pool.length) {
      this.refs.problemGrid.innerHTML = '<div class="small text-secondary">Сейчас проблемных учеников нет.</div>';
    } else {
      pool.forEach((s) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = `problem-card${s.warningYear ? ' high' : ''}`;
        card.onclick = () => this.callbacks.openStudent(s.name);
        const reasons = [];
        if (s.warningYear) reasons.push(`Годовой риск: ${s.yearRiskSubjects.slice(0, 3).join(', ')}`);
        if (s.warningCurrentTrimester) reasons.push(`${this.state.analytics.currentTrimester}: ${s.currentTrimesterRiskSubjects.slice(0, 3).join(', ')}`);
        if (Number.isFinite(s.averageGrade)) reasons.push(`Средний ${s.averageGrade.toFixed(2)}`);
        card.innerHTML = `
          <div class="d-flex justify-content-between align-items-center gap-2 mb-1">
            <div class="fw-bold small">${escapeHtml(s.name)}</div>
            ${this.avgBadge(s.averageGrade)}
          </div>
          <div class="small-muted">${escapeHtml(reasons.join(' • ') || 'Требует внимания')}</div>
        `;
        this.refs.problemGrid.appendChild(card);
      });
    }

    const trendPool = [...this.state.analytics.studentCards]
      .filter((s) => this.state.ui.showHiddenStudents || !this.isHidden(s.name))
      .filter((s) => s.strongTrendUp || s.strongTrendDown)
      .sort((a, b) => {
        const aw = (a.strongTrendDown ? 2 : 0) + (a.strongTrendUp ? 1 : 0);
        const bw = (b.strongTrendDown ? 2 : 0) + (b.strongTrendUp ? 1 : 0);
        if (bw !== aw) return bw - aw;
        return a.name.localeCompare(b.name, 'ru');
      })
      .slice(0, 12);

    this.refs.trendGrid.innerHTML = '';
    this.refs.trendMeta.textContent = trendPool.length ? `Найдено: ${trendPool.length}` : 'Сильных трендов не найдено';

    if (!trendPool.length) {
      this.refs.trendGrid.innerHTML = '<div class="small text-secondary">Сильных изменений пока нет.</div>';
    } else {
      trendPool.forEach((s) => {
        const card = document.createElement('button');
        card.type = 'button';
        card.className = `problem-card${s.strongTrendDown ? ' high' : ''}`;
        card.onclick = () => this.callbacks.openStudent(s.name);

        const reasons = [];
        if (s.strongTrendUp) {
          const names = (s.strongTrendUpSubjects || []).slice(0, 4).join(', ');
          reasons.push(names ? `↑↑ ${names}` : '↑↑ Сильный рост');
        }
        if (s.strongTrendDown) {
          const names = (s.strongTrendDownSubjects || []).slice(0, 4).join(', ');
          reasons.push(names ? `↓↓ ${names}` : '↓↓ Сильное снижение');
        }

        card.innerHTML = `
          <div class="d-flex justify-content-between align-items-center gap-2 mb-1">
            <div class="fw-bold small">${escapeHtml(s.name)}</div>
            <div class="d-inline-flex gap-1">
              ${s.strongTrendUp ? '<span class="badge text-bg-success">↑↑</span>' : ''}
              ${s.strongTrendDown ? '<span class="badge text-bg-danger">↓↓</span>' : ''}
            </div>
          </div>
          <div class="small-muted">${escapeHtml(reasons.join(' • ') || 'Есть сильный тренд')}</div>
        `;
        this.refs.trendGrid.appendChild(card);
      });
    }

    const pointsPool = [...this.state.analytics.studentCards]
      .filter((s) => this.state.ui.showHiddenStudents || !this.isHidden(s.name))
      .filter((s) => s.hasPoints)
      .sort((a, b) => {
        const ac = Number(a.pointsCount || 0);
        const bc = Number(b.pointsCount || 0);
        if (bc !== ac) return bc - ac;
        return a.name.localeCompare(b.name, 'ru');
      })
      .slice(0, 12);

    this.refs.pointsGrid.innerHTML = '';
    this.refs.pointsMeta.textContent = pointsPool.length ? `Найдено: ${pointsPool.length}` : 'Точек не найдено';

    if (!pointsPool.length) {
      this.refs.pointsGrid.innerHTML = '<div class="small text-secondary">Сейчас учеников с точками нет.</div>';
      return;
    }

    pointsPool.forEach((s) => {
      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'problem-card';
      card.onclick = () => this.callbacks.openStudent(s.name);
      const subj = (s.pointSubjects || []).slice(0, 4).join(', ');
      card.innerHTML = `
        <div class="d-flex justify-content-between align-items-center gap-2 mb-1">
          <div class="fw-bold small">${escapeHtml(s.name)}</div>
          <div class="d-inline-flex gap-1">
            <span class="badge text-bg-info">• ${Number(s.pointsCount || 0)}</span>
          </div>
        </div>
        <div class="small-muted">${escapeHtml(subj ? `Точки: ${subj}` : 'Есть точки в предметах')}</div>
      `;
      this.refs.pointsGrid.appendChild(card);
    });
  }

  renderStudentAnalytics() {
    const isFinalOnly = this.state.ui.analyticsViewMode === 'final';
    const viewModeGroup = this.refs.viewModeAllBtn?.parentElement || null;
    const tableWrap = this.refs.analyticsTableBody?.closest('.table-responsive') || null;
    this.refs.viewModeAllBtn.className = `btn btn-sm ${isFinalOnly ? 'btn-outline-primary' : 'btn-primary'}`;
    this.refs.viewModeFinalBtn.className = `btn btn-sm ${isFinalOnly ? 'btn-primary' : 'btn-outline-primary'}`;

    const name = this.state.analytics.selectedStudent;
    if (!name) {
      if (viewModeGroup) viewModeGroup.style.display = 'none';
      if (tableWrap) tableWrap.style.display = 'none';
      this.refs.analyticsTitle.textContent = 'Сводка по классу';
      this.refs.analyticsStats.textContent = 'Проблемные ученики, сильные тренды и точки ниже.';
      this.refs.analyticsTableBody.innerHTML = '<tr><td colspan="7" class="text-secondary p-3">Выберите ученика слева.</td></tr>';
      return;
    }
    if (viewModeGroup) viewModeGroup.style.display = '';
    if (tableWrap) tableWrap.style.display = '';

    const rows = this.state.analytics.byStudent[name] || [];
    let subjectRows = buildSubjectRows(rows, this.state.analytics.trimesterLabels, this.state.config.trimesterBoundaries || []);
    if (isFinalOnly) {
      subjectRows = subjectRows.filter((r) => {
        const t = this.state.analytics.trimesterLabels;
        const hasFinalTrimester = t.some((label) => r.trimesterSource?.[label] === 'final');
        return hasFinalTrimester || r.yearSource === 'final';
      });
    }
    const absences = subjectRows.reduce((sum, x) => sum + Number(x.absencesCount || 0), 0);

    this.refs.analyticsTitle.textContent = name;
    this.refs.analyticsStats.textContent = `Предметов: ${subjectRows.length}, записей: ${rows.length}, пропусков: ${absences}, текущий: ${this.state.analytics.currentTrimester}`;

    if (!subjectRows.length) {
      this.refs.analyticsTableBody.innerHTML = '<tr><td colspan="7" class="text-secondary p-3">Нет данных по ученику.</td></tr>';
      return;
    }

    this.refs.analyticsTableBody.innerHTML = '';
    subjectRows.forEach((r) => {
      const tr = document.createElement('tr');
      tr.className = this.rowClassByYearAvg(r.averageGrade);

      const trimHtml = (r.marksByTrimester || []).map((b) => {
        const badges = (b.marks || []).map((m) => (
          `<span class="badge rounded-pill ${badgeClass(m.mark)} mark-badge me-1 mb-1" data-bs-toggle="tooltip" data-bs-title="${escapeHtml(m.tooltip)}">${escapeHtml(m.mark)}${Number(m.weight) > 1 ? `<span class="ms-1">×${m.weight}</span>` : ''}${m.isPoint ? '<span class="ms-1" style="opacity:.9">•</span>' : ''}</span>`
        )).join('');
        return `<div class="mb-2"><div class="trim-title">${escapeHtml(b.trimester)}</div><div>${badges || '<span class="small text-secondary">—</span>'}</div></div>`;
      }).join('');

      const t = this.state.analytics.trimesterLabels;
      const t1 = isFinalOnly && r.trimesterSource?.[t[0]] !== 'final' ? null : r.trimesterRounded?.[t[0]];
      const t2 = isFinalOnly && r.trimesterSource?.[t[1]] !== 'final' ? null : r.trimesterRounded?.[t[1]];
      const t3 = isFinalOnly && r.trimesterSource?.[t[2]] !== 'final' ? null : r.trimesterRounded?.[t[2]];
      const s1 = r.trimesterSource?.[t[0]] === 'final';
      const s2 = r.trimesterSource?.[t[1]] === 'final';
      const s3 = r.trimesterSource?.[t[2]] === 'final';
      const annualValue = isFinalOnly && r.yearSource !== 'final' ? null : r.averageGrade;

      const trend = r.trend === 'up'
        ? (r.trendStrength === 'strong'
          ? '<span style="color:#198754" title="Сильный тренд вверх">↑↑</span> '
          : '<span style="color:#198754" title="Тренд вверх">▲</span> ')
        : r.trend === 'down'
          ? (r.trendStrength === 'strong'
            ? '<span style="color:#dc3545" title="Сильный тренд вниз">↓↓</span> '
            : '<span style="color:#dc3545" title="Тренд вниз">▼</span> ')
          : '';

      const trimBadge = (v, isFinal) => {
        if (!Number.isFinite(v)) return '<span class="badge text-bg-secondary">—</span>';
        return `<span class="badge ${badgeClass(v)}${isFinal ? ' trimester-final' : ''}">${Math.round(v)}</span>`;
      };

      tr.innerHTML = `
        <td>${trend}${escapeHtml(r.subject)}${r.hasPoints ? ` <span class="badge text-bg-info" title="Есть точки: ${Number(r.pointsCount || 0)}">•</span>` : ''}</td>
        <td class="text-center">${trimBadge(t1, s1)}</td>
        <td class="text-center">${trimBadge(t2, s2)}</td>
        <td class="text-center">${trimBadge(t3, s3)}</td>
        <td class="text-center">${this.avgBadge(annualValue)}</td>
        <td class="text-center">${r.absencesCount || 0}</td>
        <td class="marks-cell">${isFinalOnly ? '<span class="small text-secondary">—</span>' : (trimHtml || '<span class="small text-secondary">—</span>')}</td>
      `;
      this.refs.analyticsTableBody.appendChild(tr);
    });

    const tooltips = this.refs.analyticsTableBody.querySelectorAll('[data-bs-toggle="tooltip"]');
    tooltips.forEach((el) => new window.bootstrap.Tooltip(el));
  }

  bind() {
    this.refs.studentSearch.addEventListener('input', (e) => {
      this.state.ui.search = e.target.value;
      this.renderStudentsList();
    });

    this.refs.studentSort.addEventListener('change', (e) => {
      this.state.ui.sort = e.target.value;
      this.renderStudentsList();
    });

    this.refs.showHiddenStudents.addEventListener('change', (e) => {
      this.callbacks.changeShowHidden(Boolean(e.target.checked));
    });

    this.refs.classFilter.addEventListener('change', async (e) => {
      await this.callbacks.changeClassFilter(String(e.target.value || '__all__'));
    });

    this.refs.viewModeAllBtn.addEventListener('click', () => {
      this.callbacks.changeViewMode('all');
    });

    this.refs.viewModeFinalBtn.addEventListener('click', () => {
      this.callbacks.changeViewMode('final');
    });

    this.refs.goSummaryBtn?.addEventListener('click', () => {
      this.callbacks.goSummary();
    });
  }
}
