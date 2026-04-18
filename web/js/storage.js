import { isTokenExpired, normalizeName } from './utils.js';

export const KEYS = {
  auth: 'mesh_auth_v1',
  hiddenStudents: 'mesh_hidden_students_v1',
  classFilter: 'mesh_analytics_class_unit_v1',
  showHidden: 'mesh_show_hidden_students'
};

export function loadAuth() {
  try {
    const raw = localStorage.getItem(KEYS.auth);
    if (!raw) return null;
    const auth = JSON.parse(raw);
    if (!auth || !auth.token || !auth.profileId) return null;
    if (isTokenExpired(auth.token)) return null;
    return auth;
  } catch (_) {
    return null;
  }
}

export function saveAuth(auth) {
  localStorage.setItem(KEYS.auth, JSON.stringify(auth));
}

export function clearAuth() {
  localStorage.removeItem(KEYS.auth);
}

export function loadHiddenStudentsSet() {
  const set = new Set();
  try {
    const raw = localStorage.getItem(KEYS.hiddenStudents);
    const parsed = JSON.parse(raw || '[]');
    (Array.isArray(parsed) ? parsed : []).forEach((name) => {
      const key = normalizeName(name);
      if (key) set.add(key);
    });
  } catch (_) {
  }
  return set;
}

export function saveHiddenStudentsSet(set) {
  localStorage.setItem(
    KEYS.hiddenStudents,
    JSON.stringify([...set].sort((a, b) => a.localeCompare(b, 'ru')))
  );
}

export function loadClassFilter() {
  return localStorage.getItem(KEYS.classFilter) || '__all__';
}

export function saveClassFilter(value) {
  localStorage.setItem(KEYS.classFilter, String(value || '__all__'));
}

export function loadShowHidden() {
  return localStorage.getItem(KEYS.showHidden) === '1';
}

export function saveShowHidden(enabled) {
  localStorage.setItem(KEYS.showHidden, enabled ? '1' : '0');
}
