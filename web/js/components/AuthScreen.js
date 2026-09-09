import { norm } from '../utils.js';

function findTeacherProfile(profiles) {
  const list = Array.isArray(profiles) ? profiles : [];
  return list.find((profile) => {
    const roles = Array.isArray(profile?.roles) ? profile.roles : [];
    return profile?.type === 'teacher' || roles.includes('teacher');
  }) || list[0] || null;
}

function parseAuthPayload(raw) {
  const text = String(raw || '').trim();
  if (!text.startsWith('{')) return null;

  try {
    const data = JSON.parse(text);
    const profile = findTeacherProfile(data.profiles);
    return {
      token: data.authentication_token || data.token || data.aupd_token || '',
      profileId: data.profile_id || data.profileId || profile?.id || '',
      roleId: data.role_id || data.roleId || '',
      hostId: data.host_id || data.hostId || ''
    };
  } catch (_) {
    return null;
  }
}

export class AuthScreen {
  constructor(refs, { onSave }) {
    this.refs = refs;
    this.onSave = onSave;
  }

  fill(auth) {
    this.refs.tokenInput.value = auth?.token || '';
    this.refs.profileInput.value = auth?.profileId || '';
    this.refs.roleInput.value = auth?.roleId || '9';
    this.refs.hostInput.value = auth?.hostId || '9';
  }

  bind() {
    this.refs.saveAuthBtn.addEventListener('click', async () => {
      try {
        this.refs.authStatus.textContent = 'Проверяем...';
        const parsed = parseAuthPayload(this.refs.tokenInput.value) || {};
        const auth = {
          token: norm(parsed.token || this.refs.tokenInput.value),
          profileId: norm(this.refs.profileInput.value || parsed.profileId),
          roleId: norm(this.refs.roleInput.value || parsed.roleId) || '9',
          hostId: norm(this.refs.hostInput.value || parsed.hostId) || '9'
        };
        if (!auth.token || !auth.profileId) throw new Error('Заполните token и profile_id');
        this.fill(auth);
        await this.onSave(auth);
        this.refs.authStatus.textContent = 'Готово';
      } catch (err) {
        this.refs.authStatus.textContent = err.message;
      }
    });
  }
}
