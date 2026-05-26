import {
  loadAuth,
  saveAuth,
  clearAuth,
  loadHiddenStudentsSet,
  saveHiddenStudentsSet,
  loadClassFilter,
  saveClassFilter,
  loadShowHidden,
  saveShowHidden
} from './storage.js';
import { createApiClient, fetchJson } from './api.js';
import { normalizeName } from './utils.js';
import { AuthScreen } from './components/AuthScreen.js';
import { ModeScreen } from './components/ModeScreen.js';
import { AnalyticsScreen } from './components/AnalyticsScreen.js';
import { MarkingScreen } from './components/MarkingScreen.js';
import { FinalMarksScreen } from './components/FinalMarksScreen.js';
import { SoftSkillsScreen } from './components/SoftSkillsScreen.js';
import { loadAnalyticsData } from './engines/analytics.js';
import { loadGroupsForMarking, loadControlFormsForMarking, buildMarkingPreview, applyMarkingPreview, buildFinalMarksPreview, applyFinalMarksPreview } from './engines/marking.js';
import { buildSoftSkillsPlan, applySoftSkillsPlan } from './engines/softSkills.js';

const state = {
  config: null,
  auth: null,
  hiddenStudents: new Set(),
  analytics: {
    loaded: false,
    loading: false,
    students: [],
    byStudent: {},
    studentCards: [],
    trimesterLabels: ['1 триместр', '2 триместр', '3 триместр'],
    currentTrimester: '1 триместр',
    trimesterPeriodIds: {},
    academicYearId: null,
    selectedStudent: '',
    classOptions: [],
    selectedClassUnitId: '__all__'
  },
  marking: {
    loaded: false,
    loading: false,
    groups: [],
    controlForms: [],
    controlFormsGroupId: '',
    selectedControlFormId: '',
    selectedControlFormLabel: '',
    comment: '',
    preview: null
  },
  finalMarks: {
    loading: false,
    groups: [],
    selectedGroupId: '',
    preview: null
  },
  softSkills: {
    loading: false,
    result: null
  },
  ui: {
    search: '',
    sort: 'avg_desc',
    showHiddenStudents: false,
    analyticsViewMode: 'all',
    analyticsGradeMode: 'mixed'
  }
};

const refs = {
  authScreen: document.getElementById('authScreen'),
  modeScreen: document.getElementById('modeScreen'),
  analyticsScreen: document.getElementById('analyticsScreen'),
  markingScreen: document.getElementById('markingScreen'),
  finalMarksScreen: document.getElementById('finalMarksScreen'),
  softSkillsScreen: document.getElementById('softSkillsScreen'),
  backBtn: document.getElementById('backBtn'),
  logoutBtn: document.getElementById('logoutBtn'),

  tokenInput: document.getElementById('tokenInput'),
  profileInput: document.getElementById('profileInput'),
  roleInput: document.getElementById('roleInput'),
  hostInput: document.getElementById('hostInput'),
  aidInput: document.getElementById('aidInput'),
  authStatus: document.getElementById('authStatus'),
  saveAuthBtn: document.getElementById('saveAuthBtn'),

  openAnalyticsModeBtn: document.getElementById('openAnalyticsModeBtn'),
  openMarkingModeBtn: document.getElementById('openMarkingModeBtn'),
  openFinalMarksModeBtn: document.getElementById('openFinalMarksModeBtn'),
  openSoftSkillsModeBtn: document.getElementById('openSoftSkillsModeBtn'),

  analyticsLoader: document.getElementById('analyticsLoader'),
  analyticsLoaderText: document.getElementById('analyticsLoaderText'),
  analyticsContent: document.getElementById('analyticsContent'),
  studentsList: document.getElementById('studentsList'),
  studentsMeta: document.getElementById('studentsMeta'),
  classFilter: document.getElementById('classFilter'),
  studentSearch: document.getElementById('studentSearch'),
  studentSort: document.getElementById('studentSort'),
  showHiddenStudents: document.getElementById('showHiddenStudents'),
  goSummaryBtn: document.getElementById('goSummaryBtn'),
  analyticsTitle: document.getElementById('analyticsTitle'),
  analyticsStats: document.getElementById('analyticsStats'),
  viewModeAllBtn: document.getElementById('viewModeAllBtn'),
  viewModeFinalBtn: document.getElementById('viewModeFinalBtn'),
  gradeModeMixedBtn: document.getElementById('gradeModeMixedBtn'),
  gradeModeFinalBtn: document.getElementById('gradeModeFinalBtn'),
  gradeModeCalculatedBtn: document.getElementById('gradeModeCalculatedBtn'),
  analyticsTableBody: document.getElementById('analyticsTableBody'),
  debtBlock: document.getElementById('debtBlock'),
  debtGrid: document.getElementById('debtGrid'),
  debtMeta: document.getElementById('debtMeta'),
  problemBlock: document.getElementById('problemBlock'),
  problemGrid: document.getElementById('problemGrid'),
  problemMeta: document.getElementById('problemMeta'),
  trendBlock: document.getElementById('trendBlock'),
  trendGrid: document.getElementById('trendGrid'),
  trendMeta: document.getElementById('trendMeta'),
  pointsBlock: document.getElementById('pointsBlock'),
  pointsGrid: document.getElementById('pointsGrid'),
  pointsMeta: document.getElementById('pointsMeta'),

  markingLoader: document.getElementById('markingLoader'),
  markingLoaderText: document.getElementById('markingLoaderText'),
  markingContent: document.getElementById('markingContent'),
  groupSelect: document.getElementById('groupSelect'),
  controlFormSelect: document.getElementById('controlFormSelect'),
  commentInput: document.getElementById('commentInput'),
  namesInput: document.getElementById('namesInput'),
  gradesInput: document.getElementById('gradesInput'),
  previewBtn: document.getElementById('previewBtn'),
  applyBtn: document.getElementById('applyBtn'),
  markingStatus: document.getElementById('markingStatus'),
  previewTableBody: document.getElementById('previewTableBody'),

  finalMarksLoader: document.getElementById('finalMarksLoader'),
  finalMarksLoaderText: document.getElementById('finalMarksLoaderText'),
  finalMarksContent: document.getElementById('finalMarksContent'),
  finalGroupSelect: document.getElementById('finalGroupSelect'),
  finalT1Check: document.getElementById('finalT1Check'),
  finalT2Check: document.getElementById('finalT2Check'),
  finalT3Check: document.getElementById('finalT3Check'),
  finalIntermediateCheck: document.getElementById('finalIntermediateCheck'),
  finalYearCheck: document.getElementById('finalYearCheck'),
  finalPreviewBtn: document.getElementById('finalPreviewBtn'),
  finalApplyBtn: document.getElementById('finalApplyBtn'),
  finalMarkingStatus: document.getElementById('finalMarkingStatus'),
  finalPreviewTableHead: document.getElementById('finalPreviewTableHead'),
  finalPreviewTableBody: document.getElementById('finalPreviewTableBody'),

  skillsRunBtn: document.getElementById('skillsRunBtn'),
  skillsStatus: document.getElementById('skillsStatus'),
  skillsTableBody: document.getElementById('skillsTableBody')
};

function setScreen(name) {
  const map = {
    auth: refs.authScreen,
    mode: refs.modeScreen,
    analytics: refs.analyticsScreen,
    marking: refs.markingScreen,
    finalMarks: refs.finalMarksScreen,
    softSkills: refs.softSkillsScreen
  };
  Object.values(map).forEach((el) => el.classList.remove('active'));
  if (map[name]) map[name].classList.add('active');

  refs.logoutBtn.style.display = (name === 'auth') ? 'none' : '';
  refs.backBtn.style.display = (name === 'mode' || name === 'auth') ? 'none' : '';
}

function parseRoute() {
  const hash = (location.hash || '#mode').replace(/^#/, '');
  const [head, rawParam] = hash.split('/');
  return { head: head || 'mode', param: rawParam ? decodeURIComponent(rawParam) : '' };
}

function onAuthError() {
  clearAuth();
  state.auth = null;
  location.hash = '#auth';
}

const api = createApiClient({
  getAuth: () => state.auth,
  onAuthError
});

function applyAnalyticsData(data) {
  state.analytics.students = data.students;
  state.analytics.byStudent = data.byStudent;
  state.analytics.studentCards = data.studentCards;
  state.analytics.classOptions = data.classOptions;
  state.analytics.selectedClassUnitId = data.selectedClassUnitId;
  state.analytics.currentTrimester = data.currentTrimester;
  state.analytics.trimesterLabels = data.trimesterLabels;
  state.analytics.trimesterPeriodIds = data.trimesterPeriodIds || {};
  state.analytics.academicYearId = data.academicYearId;
  state.analytics.loaded = true;

}

const authScreen = new AuthScreen(refs, {
  onSave: async (auth) => {
    saveAuth(auth);
    state.auth = auth;

    await api.meshApi(`/api/ej/core/teacher/v1/teacher_profiles/${auth.profileId}`, {
      query: { with_assigned_groups: true, with_replacement_groups: true }
    });

    state.analytics.loaded = false;
    state.marking.loaded = false;
    state.finalMarks.groups = [];
    state.finalMarks.preview = null;
    location.hash = '#mode';
  }
});

const modeScreen = new ModeScreen(refs, {
  onOpenAnalytics: () => { location.hash = '#analytics'; },
  onOpenMarking: () => { location.hash = '#marking'; },
  onOpenFinalMarks: () => { location.hash = '#final-marks'; },
  onOpenSoftSkills: () => { location.hash = '#soft-skills'; }
});

const analyticsScreen = new AnalyticsScreen(refs, state, {
  saveHiddenStudentsSet
}, {
  openStudent: (name) => {
    location.hash = `#analytics/${encodeURIComponent(name)}`;
  },
  toggleHidden: (name) => {
    const key = normalizeName(name);
    if (state.hiddenStudents.has(key)) state.hiddenStudents.delete(key);
    else state.hiddenStudents.add(key);
    saveHiddenStudentsSet(state.hiddenStudents);

    if (!state.ui.showHiddenStudents && state.hiddenStudents.has(key) && state.analytics.selectedStudent === name) {
      state.analytics.selectedStudent = '';
      location.hash = '#analytics';
      return;
    }

    analyticsScreen.renderStudentsList();
    analyticsScreen.renderProblemCards();
    analyticsScreen.renderStudentAnalytics();
  },
  changeShowHidden: (enabled) => {
    state.ui.showHiddenStudents = Boolean(enabled);
    saveShowHidden(state.ui.showHiddenStudents);
    if (!state.ui.showHiddenStudents && state.analytics.selectedStudent && state.hiddenStudents.has(normalizeName(state.analytics.selectedStudent))) {
      state.analytics.selectedStudent = '';
      location.hash = '#analytics';
      return;
    }
    analyticsScreen.renderStudentsList();
    analyticsScreen.renderProblemCards();
    analyticsScreen.renderStudentAnalytics();
  },
  changeClassFilter: async (value) => {
    saveClassFilter(value);
    state.analytics.loaded = false;
    state.analytics.selectedStudent = '';
    refs.analyticsLoaderText.textContent = 'Перезагрузка аналитики по выбранному классу...';
    await openAnalytics();
  },
  changeViewMode: (mode) => {
    state.ui.analyticsViewMode = mode === 'final' ? 'final' : 'all';
    analyticsScreen.renderStudentAnalytics();
  },
  changeGradeMode: (mode) => {
    state.ui.analyticsGradeMode = ['final', 'calculated'].includes(mode) ? mode : 'mixed';
    analyticsScreen.renderStudentAnalytics();
  },
  goSummary: () => {
    state.analytics.selectedStudent = '';
    analyticsScreen.renderStudentsList();
    analyticsScreen.renderProblemCards();
    analyticsScreen.renderStudentAnalytics();
    if (location.hash !== '#analytics') location.hash = '#analytics';
  }
});

const markingScreen = new MarkingScreen(refs, state, {
  loadControlForms: async (groupId) => {
    const data = await loadControlFormsForMarking({
      meshApi: api.meshApi,
      fetchPaged: api.fetchPaged,
      config: state.config,
      auth: state.auth,
      groupId
    });
    state.marking.controlForms = data.controlForms;
    state.marking.controlFormsGroupId = String(groupId || '');
    return data;
  },
  preview: async (payload) => {
    return buildMarkingPreview({
      meshApi: api.meshApi,
      fetchPaged: api.fetchPaged,
      config: state.config,
      auth: state.auth,
      groupId: payload.groupId,
      controlFormId: payload.controlFormId,
      namesText: payload.namesText,
      marksText: payload.marksText,
      comment: payload.comment
    });
  },
  apply: async (preview) => {
    return applyMarkingPreview({ meshApi: api.meshApi, auth: state.auth, preview });
  }
});

const finalMarksScreen = new FinalMarksScreen(refs, state, {
  preview: async ({ groupId, selectedPeriodTypes }) => {
    const gid = Number(groupId);
    if (!Number.isFinite(gid)) throw new Error('Выберите группу');
    const selectedCount = Number(selectedPeriodTypes?.trimesters?.length || 0)
      + (selectedPeriodTypes?.intermediate ? 1 : 0)
      + (selectedPeriodTypes?.year ? 1 : 0);
    if (selectedCount <= 0) throw new Error('Выберите хотя бы один тип отметок');

    const missingFinalPeriodContext = !Object.keys(state.analytics.trimesterPeriodIds || {}).length;
    const selectedGroup = (state.finalMarks.groups || []).find((g) => Number(g.id) === gid) || null;
    const relatedGroupIds = Array.isArray(selectedGroup?.relatedGroupIds) ? selectedGroup.relatedGroupIds : [];
    const currentGroupIds = new Set(
      Object.values(state.analytics.byStudent || {})
        .flat()
        .map((row) => Number(row.groupId))
        .filter(Number.isFinite)
    );
    const needsLoad = !state.analytics.loaded || !currentGroupIds.has(gid) || currentGroupIds.size !== 1 || missingFinalPeriodContext;
    if (needsLoad && !state.analytics.loading) {
      state.analytics.loading = true;
      try {
        const data = await loadAnalyticsData({
          meshApi: api.meshApi,
          fetchPaged: api.fetchPaged,
          config: state.config,
          auth: state.auth,
          groupIds: [gid],
          markGroupIdsByGroupId: { [gid]: relatedGroupIds },
          statusCb: (text) => { refs.finalMarkingStatus.textContent = text; }
        });
        applyAnalyticsData(data);
      } finally {
        state.analytics.loading = false;
      }
    }

    return buildFinalMarksPreview({
      byStudent: state.analytics.byStudent,
      trimesterLabels: state.analytics.trimesterLabels,
      trimesterBoundaries: state.config.trimesterBoundaries || [],
      trimesterPeriodIds: state.analytics.trimesterPeriodIds || {},
      academicYearId: state.analytics.academicYearId || state.config.academicYearId,
      selectedPeriodTypes
    });
  },
  apply: async (preview) => {
    return applyFinalMarksPreview({ meshApi: api.meshApi, preview });
  }
});

const softSkillsScreen = new SoftSkillsScreen(refs, state, {
  run: async ({ statusCb }) => {
    const plan = await buildSoftSkillsPlan({
      meshApi: api.meshApi,
      fetchPaged: api.fetchPaged,
      config: state.config,
      auth: state.auth,
      statusCb
    });
    return applySoftSkillsPlan({
      meshApi: api.meshApi,
      plan,
      statusCb
    });
  }
});

async function openAnalytics() {
  refs.analyticsLoader.style.display = '';
  refs.analyticsContent.style.display = 'none';

  if (!state.analytics.loaded && !state.analytics.loading) {
    state.analytics.loading = true;
    try {
      const data = await loadAnalyticsData({
        meshApi: api.meshApi,
        fetchPaged: api.fetchPaged,
        config: state.config,
        auth: state.auth,
        savedClassFilter: loadClassFilter(),
        statusCb: (text) => { refs.analyticsLoaderText.textContent = text; }
      });

      applyAnalyticsData(data);
    } finally {
      state.analytics.loading = false;
    }
  }

  refs.analyticsLoader.style.display = 'none';
  refs.analyticsContent.style.display = '';
  analyticsScreen.renderClassFilter();
  refs.showHiddenStudents.checked = Boolean(state.ui.showHiddenStudents);
  analyticsScreen.renderStudentsList();
  analyticsScreen.renderProblemCards();
  analyticsScreen.renderStudentAnalytics();
}

async function openMarking() {
  refs.markingLoader.style.display = '';
  refs.markingContent.style.display = 'none';

  if (!state.marking.loaded && !state.marking.loading) {
    state.marking.loading = true;
    try {
      const { groups } = await loadGroupsForMarking({
        meshApi: api.meshApi,
        fetchPaged: api.fetchPaged,
        config: state.config,
        auth: state.auth,
        statusCb: (text) => { refs.markingLoaderText.textContent = text; }
      });
      state.marking.groups = groups;
      state.marking.loaded = true;
      markingScreen.renderGroups();
      await markingScreen.loadControlFormsForSelectedGroup();
    } finally {
      state.marking.loading = false;
    }
  }

  refs.markingLoader.style.display = 'none';
  refs.markingContent.style.display = '';
}

async function openFinalMarks() {
  refs.finalMarksLoader.style.display = '';
  refs.finalMarksContent.style.display = 'none';

  if (!state.finalMarks.groups.length && !state.finalMarks.loading) {
    state.finalMarks.loading = true;
    try {
      const { groups } = await loadGroupsForMarking({
        meshApi: api.meshApi,
        fetchPaged: api.fetchPaged,
        config: state.config,
        auth: state.auth,
        statusCb: (text) => { refs.finalMarksLoaderText.textContent = text; }
      });
      state.finalMarks.groups = groups;
      if (!state.finalMarks.selectedGroupId && groups[0]) state.finalMarks.selectedGroupId = String(groups[0].id);
    } finally {
      state.finalMarks.loading = false;
    }
  }

  refs.finalMarksLoader.style.display = 'none';
  refs.finalMarksContent.style.display = '';
  finalMarksScreen.renderGroupOptions();
}

async function renderRoute() {
  if (!state.auth) {
    setScreen('auth');
    return;
  }

  const { head, param } = parseRoute();
  if (head === 'auth') {
    location.hash = '#mode';
    return;
  }

  if (head === 'mode' || !head) {
    setScreen('mode');
    return;
  }

  if (head === 'analytics') {
    setScreen('analytics');
    state.analytics.selectedStudent = param || '';
    await openAnalytics();
    return;
  }

  if (head === 'marking') {
    setScreen('marking');
    await openMarking();
    return;
  }

  if (head === 'final-marks') {
    setScreen('finalMarks');
    await openFinalMarks();
    return;
  }

  if (head === 'soft-skills') {
    setScreen('softSkills');
    return;
  }

  location.hash = '#mode';
}

async function init() {
  state.config = await fetchJson('/api/config');
  state.hiddenStudents = loadHiddenStudentsSet();
  state.ui.showHiddenStudents = loadShowHidden();

  const auth = loadAuth();
  if (auth) {
    state.auth = auth;
  } else {
    authScreen.fill({ roleId: '9', hostId: '9', aid: '13' });
    location.hash = '#auth';
  }

  await renderRoute();
}

refs.backBtn.addEventListener('click', () => {
  const { head } = parseRoute();
  if (head === 'analytics' || head === 'marking' || head === 'final-marks' || head === 'soft-skills') location.hash = '#mode';
});

refs.logoutBtn.addEventListener('click', () => {
  clearAuth();
  state.auth = null;
  state.analytics.loaded = false;
  state.marking.loaded = false;
  state.finalMarks.groups = [];
  state.finalMarks.preview = null;
  authScreen.fill({ roleId: '9', hostId: '9', aid: '13' });
  location.hash = '#auth';
});

window.addEventListener('hashchange', () => {
  renderRoute().catch((err) => alert(err.message || String(err)));
});

authScreen.bind();
modeScreen.bind();
analyticsScreen.bind();
markingScreen.bind();
finalMarksScreen.bind();
softSkillsScreen.bind();

init().catch((err) => {
  alert(`Ошибка запуска: ${err.message}`);
});
