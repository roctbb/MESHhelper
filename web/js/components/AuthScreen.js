import { norm } from '../utils.js';

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
    this.refs.aidInput.value = auth?.aid || '13';
  }

  bind() {
    this.refs.saveAuthBtn.addEventListener('click', async () => {
      try {
        this.refs.authStatus.textContent = 'Проверяем...';
        const auth = {
          token: norm(this.refs.tokenInput.value),
          profileId: norm(this.refs.profileInput.value),
          roleId: norm(this.refs.roleInput.value) || '9',
          hostId: norm(this.refs.hostInput.value) || '9',
          aid: norm(this.refs.aidInput.value) || '13'
        };
        if (!auth.token || !auth.profileId) throw new Error('Заполните token и profile_id');
        await this.onSave(auth);
        this.refs.authStatus.textContent = 'Готово';
      } catch (err) {
        this.refs.authStatus.textContent = err.message;
      }
    });
  }
}
