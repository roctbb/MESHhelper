function sanitizeFilePart(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9а-яА-ЯёЁ._-]/g, '')
    .slice(0, 80) || 'unknown-subject';
}

function buildApiHeaders(auth) {
  const headers = {
    Accept: '*/*',
    'Content-Type': 'application/json',
    'x-mes-subsystem': process.env.API_SUBSYSTEM || 'journalw'
  };

  if (auth.profileId) headers['Profile-Id'] = String(auth.profileId);
  if (auth.roleId) headers['X-Mes-RoleId'] = String(auth.roleId);
  if (auth.hostId) headers['x-mes-hostid'] = String(auth.hostId);
  if (auth.aid) headers.aid = String(auth.aid);
  if (auth.bearerToken) headers.Authorization = `Bearer ${auth.bearerToken}`;
  return headers;
}

function toEducationLevelId(classLevelId) {
  const n = Number(classLevelId);
  if (!Number.isFinite(n)) return 2;
  if (n <= 4) return 1;
  if (n <= 9) return 2;
  return 3;
}

async function fetchPlanGroups(request, auth, opts, debug) {
  const headers = buildApiHeaders(auth);
  const all = [];
  let pageNum = 1;

  while (pageNum <= 10) {
    const qs = new URLSearchParams({
      page: String(pageNum),
      academic_year_id: String(opts.academicYearId),
      school_id: String(opts.schoolId),
      class_unit_ids: opts.classUnitIds.join(','),
      per_page: String(opts.perPage || 300)
    });
    const url = `https://school.mos.ru/api/ej/plan/teacher/v1/groups?${qs.toString()}`;
    if (debug) debug(`GET ${url}`);
    const res = await request.get(url, { headers });
    if (!res.ok()) {
      throw new Error(`Plan groups failed: ${res.status()} ${await res.text()}`);
    }
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) break;
    all.push(...data);
    if (data.length < (opts.perPage || 300)) break;
    pageNum += 1;
  }

  return all;
}

async function fetchPlanGroupsByGroupIds(request, auth, opts, debug) {
  const headers = buildApiHeaders(auth);
  const all = [];
  const groupIds = Array.isArray(opts.groupIds)
    ? opts.groupIds.map((x) => Number(x)).filter((x) => Number.isFinite(x))
    : [];
  if (!groupIds.length) return [];

  const chunkSize = Number(opts.chunkSize) || 120;
  const perPage = Number(opts.perPage) || 300;
  for (let i = 0; i < groupIds.length; i += chunkSize) {
    const chunk = groupIds.slice(i, i + chunkSize);
    let pageNum = 1;
    while (pageNum <= 10) {
      const qs = new URLSearchParams({
        page: String(pageNum),
        academic_year_id: String(opts.academicYearId),
        school_id: String(opts.schoolId),
        group_ids: chunk.join(','),
        with_periods_schedule_id: 'true',
        per_page: String(perPage)
      });
      const url = `https://school.mos.ru/api/ej/plan/teacher/v1/groups?${qs.toString()}`;
      if (debug) debug(`GET ${url}`);
      const res = await request.get(url, { headers });
      if (!res.ok()) {
        throw new Error(`Plan groups by ids failed: ${res.status()} ${await res.text()}`);
      }
      const data = await res.json();
      if (!Array.isArray(data) || !data.length) break;
      all.push(...data);
      if (data.length < perPage) break;
      pageNum += 1;
    }
  }

  const uniq = new Map();
  for (const g of all) {
    const id = Number(g?.id);
    if (!Number.isFinite(id)) continue;
    uniq.set(id, g);
  }
  return [...uniq.values()];
}

async function fetchStudentProfiles(request, auth, opts, debug) {
  const headers = buildApiHeaders(auth);
  const out = [];
  let page = 1;
  const perPage = opts.perPage || 300;

  while (page <= 20) {
    const qs = new URLSearchParams({
      academic_year_id: String(opts.academicYearId),
      class_unit_ids: opts.classUnitIds.join(','),
      with_groups: 'true',
      with_home_based_periods: 'true',
      with_deleted: 'false',
      with_final_marks: 'true',
      with_archived_groups: 'false',
      with_transferred: 'false',
      per_page: String(perPage),
      page: String(page)
    });
    const url = `https://school.mos.ru/api/ej/core/teacher/v1/student_profiles?${qs.toString()}`;
    if (debug) debug(`GET ${url}`);
    const res = await request.get(url, { headers });
    if (!res.ok()) {
      throw new Error(`Student profiles failed: ${res.status()} ${await res.text()}`);
    }
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) break;
    out.push(...data);
    if (data.length < perPage) break;
    page += 1;
  }

  return out;
}

async function fetchTeacherProfile(request, auth, teacherProfileId, debug) {
  const headers = buildApiHeaders(auth);
  const id = Number(teacherProfileId);
  if (!Number.isFinite(id)) throw new Error('Invalid teacher profile id');
  const qs = new URLSearchParams({
    with_assigned_groups: 'true',
    with_replacement_groups: 'true'
  });
  const url = `https://school.mos.ru/api/ej/core/teacher/v1/teacher_profiles/${id}?${qs.toString()}`;
  if (debug) debug(`GET ${url}`);
  const res = await request.get(url, { headers });
  if (!res.ok()) {
    throw new Error(`Teacher profile failed: ${res.status()} ${await res.text()}`);
  }
  return res.json();
}

async function fetchMarksByGroup(request, auth, group, fromRu, toRu, perPage, debug) {
  const headers = buildApiHeaders(auth);
  const rows = [];
  let page = 1;

  while (page <= 200) {
    const qs = new URLSearchParams({
      group_ids: String(group.groupId),
      subject_id: String(group.subjectId),
      created_at_from: fromRu,
      created_at_to: toRu,
      with_non_numeric_entries: 'true',
      per_page: String(perPage),
      page: String(page)
    });
    if (Number.isFinite(group.classLevelId)) {
      qs.set('class_level_id', String(group.classLevelId));
    }
    const url = `https://school.mos.ru/api/ej/core/teacher/v1/marks?${qs.toString()}`;
    if (debug) debug(`GET marks group=${group.groupId} page=${page}`);
    const res = await request.get(url, { headers });
    if (!res.ok()) {
      throw new Error(`Marks failed for group ${group.groupId}: ${res.status()} ${await res.text()}`);
    }
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) break;
    rows.push(...data);
    if (data.length < perPage) break;
    page += 1;
  }

  return rows;
}

async function fetchAttendancesByGroup(request, auth, group, academicYearId, fromRu, toRu, perPage, debug) {
  const headers = buildApiHeaders(auth);
  const rows = [];
  let page = 1;

  while (page <= 30) {
    const qs = new URLSearchParams({
      group_ids: String(group.groupId),
      academic_year_id: String(academicYearId),
      start_at: fromRu,
      stop_at: toRu,
      page: String(page),
      per_page: String(perPage || 1000)
    });
    if (Number.isFinite(group.classLevelId)) {
      qs.set('class_level_id', String(group.classLevelId));
    }

    const url = `https://school.mos.ru/api/ej/core/teacher/v1/attendances?${qs.toString()}`;
    if (debug) debug(`GET attendances group=${group.groupId} page=${page}`);
    const res = await request.get(url, { headers });
    if (!res.ok()) {
      throw new Error(`Attendances failed for group ${group.groupId}: ${res.status()} ${await res.text()}`);
    }
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) break;
    rows.push(...data);
    if (data.length < (perPage || 1000)) break;
    page += 1;
  }

  return rows;
}

async function fetchAttestationPeriodsSchedule(request, auth, scheduleId, debug) {
  const headers = buildApiHeaders(auth);
  const url = `https://school.mos.ru/api/ej/core/teacher/v1/attestation_periods_schedules/${scheduleId}`;
  if (debug) debug(`GET ${url}`);
  const res = await request.get(url, { headers });
  if (!res.ok()) {
    throw new Error(`Attestation periods schedule failed (${scheduleId}): ${res.status()} ${await res.text()}`);
  }
  return res.json();
}

async function fetchGroupById(request, auth, groupId, debug) {
  const headers = buildApiHeaders(auth);
  const url = `https://school.mos.ru/api/ej/plan/teacher/v1/groups/${groupId}`;
  if (debug) debug(`GET ${url}`);
  const res = await request.get(url, { headers });
  if (!res.ok()) {
    throw new Error(`Group ${groupId} failed: ${res.status()} ${await res.text()}`);
  }
  return res.json();
}

async function fetchGroupStudentProfiles(request, auth, opts, debug) {
  const headers = buildApiHeaders(auth);
  const all = [];
  let page = 1;
  const perPage = Number(opts.perPage) || 150;

  while (page <= 20) {
    const qs = new URLSearchParams({
      academic_year_id: String(opts.academicYearId),
      class_unit_ids: String(opts.classUnitIds.join(',')),
      group_ids: String(opts.groupId),
      with_groups: 'true',
      with_home_based_periods: 'true',
      with_deleted: 'false',
      with_final_marks: 'true',
      with_archived_groups: 'false',
      with_transferred: 'false',
      per_page: String(perPage),
      page: String(page)
    });
    const url = `https://school.mos.ru/api/ej/core/teacher/v1/student_profiles?${qs.toString()}`;
    if (debug) debug(`GET ${url}`);
    const res = await request.get(url, { headers });
    if (!res.ok()) {
      throw new Error(`Student profiles failed: ${res.status()} ${await res.text()}`);
    }
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) break;
    all.push(...data);
    if (data.length < perPage) break;
    page += 1;
  }

  return all;
}

async function fetchScheduleItemsByGroup(request, auth, opts, debug) {
  const headers = buildApiHeaders(auth);
  const all = [];
  let page = 1;
  const perPage = Number(opts.perPage) || 300;

  while (page <= 20) {
    const qs = new URLSearchParams({
      academic_year_id: String(opts.academicYearId),
      group_ids: String(opts.groupId),
      from: String(opts.from),
      to: String(opts.to),
      with_group_class_subject_info: 'true',
      with_course_calendar_info: 'true',
      with_lesson_info: 'true',
      with_rooms_info: 'true',
      with_availability_info: 'true',
      page: String(page),
      per_page: String(perPage)
    });
    const url = `https://school.mos.ru/api/ej/plan/teacher/v1/schedule_items?${qs.toString()}`;
    if (debug) debug(`GET ${url}`);
    const res = await request.get(url, { headers });
    if (!res.ok()) {
      throw new Error(`Schedule items failed: ${res.status()} ${await res.text()}`);
    }
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) break;
    all.push(...data);
    if (data.length < perPage) break;
    page += 1;
  }

  return all;
}

async function fetchControlForms(request, auth, opts, debug) {
  const headers = buildApiHeaders(auth);
  const qs = new URLSearchParams({
    academic_year_id: String(opts.academicYearId),
    school_id: String(opts.schoolId),
    subject_id: String(opts.subjectId),
    with_grade_system: 'true',
    with_deleted: 'false',
    education_level_id: String(opts.educationLevelId || toEducationLevelId(opts.classLevelId)),
    page: '1',
    per_page: '1000'
  });
  const url = `https://school.mos.ru/api/ej/core/teacher/v1/control_forms?${qs.toString()}`;
  if (debug) debug(`GET ${url}`);
  const res = await request.get(url, { headers });
  if (!res.ok()) {
    throw new Error(`Control forms failed: ${res.status()} ${await res.text()}`);
  }
  return res.json();
}

async function createMark(request, auth, payload, debug) {
  const headers = buildApiHeaders(auth);
  const url = 'https://school.mos.ru/api/ej/core/teacher/v1/marks';
  if (debug) debug(`POST ${url} ${JSON.stringify(payload)}`);
  const res = await request.post(url, { headers, data: payload });
  if (!res.ok()) {
    throw new Error(`Create mark failed: ${res.status()} ${await res.text()}`);
  }
  return res.json();
}

async function startApiExport(request, auth, payload, debug) {
  const headers = buildApiHeaders(auth);
  if (debug) debug(`POST export ${JSON.stringify(payload)}`);
  const res = await request.post('https://school.mos.ru/api/ej/report/teacher/v1/journals/export', {
    headers,
    data: payload
  });
  if (!res.ok()) {
    throw new Error(`Export start failed: ${res.status()} ${await res.text()}`);
  }
  return res.json();
}

async function pollApiExportStatus(request, auth, statusId, debug) {
  const headers = buildApiHeaders(auth);
  for (let i = 0; i < 50; i += 1) {
    const res = await request.get(
      `https://school.mos.ru/api/ej/report/teacher/v1/journals/export/status/${statusId}`,
      { headers }
    );
    if (!res.ok()) {
      throw new Error(`Export status failed: ${res.status()} ${await res.text()}`);
    }
    const data = await res.json();
    if (debug) debug(`status ${statusId} -> ${data.status}`);
    if (String(data.status).toLowerCase() === 'done') return data;
    if (String(data.status).toLowerCase() === 'error') {
      throw new Error(`Export status error for ${statusId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2500));
  }
  throw new Error(`Export status timeout for ${statusId}`);
}

async function downloadByUuid(request, auth, statusId, uuid, outputDir, groupMeta, debug) {
  const headers = buildApiHeaders(auth);
  const candidates = [
    `https://school.mos.ru/api/ej/report/teacher/v1/journals/export/download/${uuid}`,
    `https://school.mos.ru/api/ej/report/teacher/v1/journals/export/file/${uuid}`,
    `https://school.mos.ru/api/ej/report/teacher/v1/journals/export/status/${statusId}/download`,
    `https://school.mos.ru/api/ej/report/teacher/v1/journals/export/status/${statusId}`
  ];

  for (const url of candidates) {
    if (debug) debug(`download candidate: ${url}`);
    const res = await request.get(url, { headers });
    if (!res.ok()) continue;
    const ctype = (res.headers()['content-type'] || '').toLowerCase();
    const looksBinary =
      ctype.includes('spreadsheet') ||
      ctype.includes('octet-stream') ||
      ctype.includes('excel') ||
      ctype.includes('xlsx') ||
      ctype.includes('openxmlformats-officedocument') ||
      ctype.includes('ms-excel');
    if (!looksBinary) continue;

    const fileName = `group-${groupMeta.groupId}-${sanitizeFilePart(groupMeta.subject)}-${uuid}.xlsx`;
    const filePath = require('path').resolve(outputDir, fileName);
    require('fs').writeFileSync(filePath, await res.body());
    if (debug) debug(`saved: ${filePath}`);
    return filePath;
  }
  return null;
}

module.exports = {
  buildApiHeaders,
  toEducationLevelId,
  fetchPlanGroups,
  fetchPlanGroupsByGroupIds,
  fetchTeacherProfile,
  fetchStudentProfiles,
  fetchMarksByGroup,
  fetchAttendancesByGroup,
  fetchAttestationPeriodsSchedule,
  fetchGroupById,
  fetchGroupStudentProfiles,
  fetchScheduleItemsByGroup,
  fetchControlForms,
  createMark,
  startApiExport,
  pollApiExportStatus,
  downloadByUuid
};
