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
import { loadAnalyticsData } from './engines/analytics.js';
import { loadGroupsForMarking, buildMarkingPreview, applyMarkingPreview } from './engines/marking.js';

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
    selectedStudent: '',
    classOptions: [],
    selectedClassUnitId: '__all__'
  },
  marking: {
    loaded: false,
    loading: false,
    groups: [],
    preview: null
  },
  ui: {
    search: '',
    sort: 'avg_desc',
    showHiddenStudents: false,
    analyticsViewMode: 'all'
  }
};

const refs = {
  authScreen: document.getElementById('authScreen'),
  modeScreen: document.getElementById('modeScreen'),
  analyticsScreen: document.getElementById('analyticsScreen'),
  markingScreen: document.getElementById('markingScreen'),
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
  analyticsTableBody: document.getElementById('analyticsTableBody'),
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
  commentInput: document.getElementById('commentInput'),
  namesInput: document.getElementById('namesInput'),
  gradesInput: document.getElementById('gradesInput'),
  previewBtn: document.getElementById('previewBtn'),
  applyBtn: document.getElementById('applyBtn'),
  markingStatus: document.getElementById('markingStatus'),
  previewTableBody: document.getElementById('previewTableBody')
};

function setScreen(name) {
  const map = {
    auth: refs.authScreen,
    mode: refs.modeScreen,
    analytics: refs.analyticsScreen,
    marking: refs.markingScreen
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

const authScreen = new AuthScreen(refs, {
  onSave: async (auth) => {
    saveAuth(auth);
    state.auth = auth;

    await api.meshApi(`/api/ej/core/teacher/v1/teacher_profiles/${auth.profileId}`, {
      query: { with_assigned_groups: true, with_replacement_groups: true }
    });

    state.analytics.loaded = false;
    state.marking.loaded = false;
    location.hash = '#mode';
  }
});

const modeScreen = new ModeScreen(refs, {
  onOpenAnalytics: () => { location.hash = '#analytics'; },
  onOpenMarking: () => { location.hash = '#marking'; }
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
  goSummary: () => {
    state.analytics.selectedStudent = '';
    analyticsScreen.renderStudentsList();
    analyticsScreen.renderProblemCards();
    analyticsScreen.renderStudentAnalytics();
    if (location.hash !== '#analytics') location.hash = '#analytics';
  }
});

const markingScreen = new MarkingScreen(refs, state, {
  preview: async (payload) => {
    return buildMarkingPreview({
      meshApi: api.meshApi,
      fetchPaged: api.fetchPaged,
      config: state.config,
      groupId: payload.groupId,
      namesText: payload.namesText,
      marksText: payload.marksText,
      comment: payload.comment
    });
  },
  apply: async (preview) => {
    return applyMarkingPreview({ meshApi: api.meshApi, auth: state.auth, preview });
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

      state.analytics.students = data.students;
      state.analytics.byStudent = data.byStudent;
      state.analytics.studentCards = data.studentCards;
      state.analytics.classOptions = data.classOptions;
      state.analytics.selectedClassUnitId = data.selectedClassUnitId;
      state.analytics.currentTrimester = data.currentTrimester;
      state.analytics.trimesterLabels = data.trimesterLabels;
      state.analytics.loaded = true;
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
    } finally {
      state.marking.loading = false;
    }
  }

  refs.markingLoader.style.display = 'none';
  refs.markingContent.style.display = '';
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
  if (head === 'analytics' || head === 'marking') location.hash = '#mode';
});

refs.logoutBtn.addEventListener('click', () => {
  clearAuth();
  state.auth = null;
  state.analytics.loaded = false;
  state.marking.loaded = false;
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

init().catch((err) => {
  alert(`Ошибка запуска: ${err.message}`);
});
