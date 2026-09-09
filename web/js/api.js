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

    if (/^\/api\/ej\/(plan|core)\/teacher\/v1\/(groups|teacher_profiles)(\/\d+)?$/.test(path)) {
      const data = result.data;
      const sample = Array.isArray(data) ? data[0] : data;
      const countIds = (value) => value == null || value === '' ? 0 : String(value).split(',').length;
      console.info('[MESHhelper] API discovery', JSON.stringify({
        path: path.replace(/\/\d+$/, '/:id'),
        status: result.status,
        academicYearId: query?.academic_year_id ?? null,
        responseAcademicYearId: Number.isInteger(Number(sample?.academic_year_id)) && Number(sample?.academic_year_id) > 0
          ? Number(sample.academic_year_id) : null,
        page: query?.page ?? null,
        groupFilterCount: countIds(query?.group_ids),
        classFilterCount: countIds(query?.class_unit_ids),
        responseType: Array.isArray(data) ? 'array' : data === null ? 'null' : typeof data,
        count: Array.isArray(data) ? data.length : null,
        fields: sample && typeof sample === 'object' ? Object.keys(sample).sort() : [],
        assignedGroupCount: Array.isArray(sample?.assigned_group_ids) ? sample.assigned_group_ids.length : null,
        groupCount: Array.isArray(sample?.group_ids) ? sample.group_ids.length : null
      }));
    }

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
      if (!Array.isArray(data)) {
        throw new Error(`Неожиданный формат ответа МЭШ: ${path} (ожидался список)`);
      }
      if (data.length === 0) break;
      out.push(...data);
      if (data.length < perPage) break;
    }
    return out;
  }

  return { meshApi, fetchPaged };
}
