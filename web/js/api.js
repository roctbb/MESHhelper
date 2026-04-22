export async function fetchJson(url, options) {
  const res = await fetch(url, options || {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

export function createApiClient({ getAuth, onAuthError }) {
  async function meshApi(path, { method = 'GET', query = null, body = null, subsystem = 'journalw' } = {}) {
    const auth = getAuth();
    if (!auth) throw new Error('Не задана авторизация');

    const result = await fetchJson('/api/mesh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        method,
        path,
        query,
        body,
        subsystem,
        auth: {
          token: auth.token,
          profileId: auth.profileId,
          roleId: auth.roleId,
          hostId: auth.hostId,
          aid: auth.aid
        }
      })
    });

    if (!result.ok) {
      const message = typeof result.data === 'string'
        ? result.data
        : result.data?.message || result.data?.error || `API ${result.status}`;

      if (result.status === 401 || /token|jwt|auth/i.test(String(message))) {
        onAuthError?.();
      }
      throw new Error(message);
    }
    return result.data;
  }

  async function fetchPaged(path, baseQuery, perPage, maxPages) {
    const out = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const query = { ...baseQuery, page, per_page: perPage };
      const data = await meshApi(path, { query });
      if (!Array.isArray(data) || data.length === 0) break;
      out.push(...data);
      if (data.length < perPage) break;
    }
    return out;
  }

  return { meshApi, fetchPaged };
}
