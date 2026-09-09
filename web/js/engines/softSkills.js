import { norm, parallelMap } from '../utils.js';
import { loadGroupsForMarking } from './marking.js';

const DEFAULT_ACADEMIC_YEAR_ID = 14;
const SOFT_SKILLS_SUBSYSTEM = 'teacherweb';

function studentName(profile) {
  const fio = [profile?.last_name, profile?.first_name, profile?.middle_name].map(norm).filter(Boolean).join(' ');
  return fio || norm(profile?.user_name || profile?.short_name || `ID ${profile?.id || ''}`);
}

function pickAnswerId(questionData) {
  const answers = Array.isArray(questionData?.answers) ? questionData.answers : [];
  const preferred = answers.find((answer) => /почти\s+всегда/i.test(norm(answer.answer_view || answer.answer)));
  if (preferred && Number.isFinite(Number(preferred.answer_id))) return Number(preferred.answer_id);

  const weighted = answers
    .map((answer) => ({ id: Number(answer.answer_id), weight: Number(answer.answer_weight) }))
    .filter((answer) => Number.isFinite(answer.id) && Number.isFinite(answer.weight))
    .sort((a, b) => b.weight - a.weight);
  return weighted[0]?.id || 4;
}

function buildAnswers(questionData) {
  const answerId = pickAnswerId(questionData);
  const groups = Array.isArray(questionData?.question_groups) ? questionData.question_groups : [];
  return groups.flatMap((group) => (
    (Array.isArray(group.questions) ? group.questions : [])
      .map((question) => Number(question.question_id))
      .filter(Number.isFinite)
      .map((questionId) => ({ question_id: String(questionId), answer_id: answerId }))
  ));
}

async function loadTeacher({ meshApi, auth }) {
  const direct = await meshApi(`/api/ej/core/teacher/v1/teacher_profiles/${auth.profileId}`, {
    query: { with_assigned_groups: true, with_replacement_groups: true }
  }).catch(() => null);
  if (direct) return direct;

  const list = await meshApi('/api/ej/core/teacher/v1/teacher_profiles', {
    query: { group_ids: '' }
  });
  return Array.isArray(list) ? list.find((x) => Number(x.id) === Number(auth.profileId)) || list[0] : list;
}

export async function buildSoftSkillsPlan({ meshApi, fetchPaged, config, auth, statusCb }) {
  const teacher = await loadTeacher({ meshApi, auth });
  const staffId = Number(teacher?.user_integration_id || teacher?.integration_id);
  if (!Number.isFinite(staffId)) throw new Error('Не удалось определить staff_id учителя');

  const { groups } = await loadGroupsForMarking({ meshApi, fetchPaged, config, auth, statusCb });
  const unique = new Map();

  await parallelMap(groups, 4, async (group, idx) => {
    statusCb(`Получаем учеников... ${idx + 1}/${groups.length}`);
    const profiles = await fetchPaged('/api/ej/core/teacher/v1/student_profiles', {
      academic_year_id: Number(config.academicYearId) || DEFAULT_ACADEMIC_YEAR_ID,
      class_unit_ids: (group.classUnitIds || []).join(','),
      group_ids: group.id,
      with_groups: true,
      with_home_based_periods: true,
      with_deleted: false,
      with_final_marks: false,
      with_archived_groups: false,
      with_transferred: false
    }, 200, 20);

    profiles.forEach((profile) => {
      const personId = norm(profile.person_id);
      if (!personId || unique.has(personId)) return;
      unique.set(personId, {
        personId,
        studentProfileId: Number(profile.id) || null,
        studentName: studentName(profile),
        classLevelId: Number(profile.class_level || profile.class_unit?.class_level_id || group.classLevelId) || null,
        groupId: group.id,
        groupName: group.name,
        status: 'pending',
        reason: ''
      });
    });
  });

  return {
    staffId,
    groupsCount: groups.length,
    rows: [...unique.values()].sort((a, b) => a.studentName.localeCompare(b.studentName, 'ru'))
  };
}

export async function applySoftSkillsPlan({ meshApi, plan, statusCb }) {
  const rows = Array.isArray(plan?.rows) ? plan.rows : [];
  const questionCache = new Map();
  const out = [];

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    statusCb(`Заполняем учебные умения... ${i + 1}/${rows.length}`);

    try {
      const period = await meshApi('/api/soft_skills/v1/periods/checkCurrentPeriodTeacher', {
        subsystem: SOFT_SKILLS_SUBSYSTEM,
        query: { student_person_id: row.personId }
      });
      const periodId = Number(period?.period_id);
      if (!Number.isFinite(periodId)) {
        out.push({ ...row, status: 'skip_no_period', reason: 'Нет текущего периода' });
        continue;
      }

      if (!questionCache.has(row.classLevelId)) {
        const questions = await meshApi('/api/soft_skills/v1/survey/questionsAnswers', {
          subsystem: SOFT_SKILLS_SUBSYSTEM,
          query: { parallel: row.classLevelId }
        });
        questionCache.set(row.classLevelId, buildAnswers(questions));
      }

      const answers = questionCache.get(row.classLevelId) || [];
      if (!answers.length) {
        out.push({ ...row, status: 'error', reason: 'Не найдены вопросы анкеты' });
        continue;
      }

      await meshApi('/api/soft_skills/v1/teacherSubjects/forTeacher', {
        subsystem: SOFT_SKILLS_SUBSYSTEM,
        query: {
          student_person_id: row.personId,
          staff_id: plan.staffId
        }
      });

      await meshApi('/api/soft_skills/v1/survey', {
        method: 'POST',
        subsystem: SOFT_SKILLS_SUBSYSTEM,
        body: {
          student_person_id: row.personId,
          period_id: periodId,
          answers
        }
      });

      out.push({
        ...row,
        periodId,
        answersCount: answers.length,
        status: period?.answers_exists ? 'updated' : 'created',
        reason: ''
      });
    } catch (err) {
      out.push({ ...row, status: 'error', reason: err.message || 'Ошибка API' });
    }
  }

  return {
    ...plan,
    rows: out,
    summary: {
      created: out.filter((x) => x.status === 'created').length,
      updated: out.filter((x) => x.status === 'updated').length,
      skipped: out.filter((x) => String(x.status).startsWith('skip')).length,
      errors: out.filter((x) => x.status === 'error').length
    }
  };
}
