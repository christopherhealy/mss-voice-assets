import { pool } from "../lib/db.js";

export async function loadExperienceContext({ experienceKey, levelNo = 1 }) {
  const key = String(experienceKey || "").trim();
  const level = Number(levelNo || 1);

  if (!key) throw new Error("missing_experience_key");
  if (!Number.isInteger(level) || level < 1) throw new Error("invalid_level_no");

  const q = await pool.query(
    `
      select
        e.experience_id,
        e.experience_key,
        e.title as experience_title,
        e.short_description,
        e.category,

        ev.experience_version_id,
        ev.version_no,
        ev.goal as experience_goal,
        ev.can_do_statement as experience_can_do_statement,
        ev.learner_situation,
        ev.host_role,
        ev.scenario_context,
        ev.ai_instructions as version_ai_instructions,
        ev.estimated_minutes,

        h.host_id,
        h.host_key,
        h.display_name as host_name,
        h.role_name,
        h.character_brief,
        h.world_rules,
        h.interaction_rules,
        h.voice_key,
        h.gender_style,

        el.experience_level_id,
        el.level_no,
        el.title as level_title,
        el.difficulty_description,
        el.scenario_modifier,
        el.ai_instructions as level_ai_instructions,
        el.badge_title,

        g.experience_gate_id,
        g.gate_no,
        g.gate_key,
        g.title as gate_title,
        g.learner_goal,
        g.can_do_statement as gate_can_do_statement,
        g.scene_context,
        g.host_objective,
        g.completion_criteria,
        g.host_seed_prompt,
        g.transition_instruction,
        g.ai_instructions as gate_ai_instructions,
        g.host_opening_text

      from experiences e
      join experience_versions ev
        on ev.experience_id = e.experience_id
       and ev.status = 'current'
      left join experience_hosts h
        on h.host_id = ev.host_id
      join experience_levels el
        on el.experience_version_id = ev.experience_version_id
       and el.level_no = $2
      join experience_gates g
        on g.experience_level_id = el.experience_level_id

      where e.experience_key = $1
        and e.status = 'published'

      order by g.gate_no asc
    `,
    [key, level]
  );

  if (!q.rows.length) {
    const err = new Error("experience_context_not_found");
    err.status = 404;
    throw err;
  }

  const first = q.rows[0];

  return {
    source: "database",
    experience: {
      id: first.experience_id,
      key: first.experience_key,
      title: first.experience_title,
      shortDescription: first.short_description,
      category: first.category,
      versionId: first.experience_version_id,
      versionNo: first.version_no,
      goal: first.experience_goal,
      canDoStatement: first.experience_can_do_statement,
      learnerSituation: first.learner_situation,
      hostRole: first.host_role,
      scenarioContext: first.scenario_context,
      aiInstructions: first.version_ai_instructions,
      estimatedMinutes: first.estimated_minutes,
    },
    host: {
      id: first.host_id,
      key: first.host_key,
      name: first.host_name,
      roleName: first.role_name,
      characterBrief: first.character_brief,
      worldRules: first.world_rules,
      interactionRules: first.interaction_rules,
      voiceKey: first.voice_key,
      genderStyle: first.gender_style,
    },
    level: {
      id: first.experience_level_id,
      number: first.level_no,
      title: first.level_title,
      difficultyDescription: first.difficulty_description,
      scenarioModifier: first.scenario_modifier,
      aiInstructions: first.level_ai_instructions,
      badgeTitle: first.badge_title,
    },
    objectives: q.rows.map(row => ({
      id: row.experience_gate_id,
      number: row.gate_no,
      key: row.gate_key,
      title: row.gate_title,
      learnerGoal: row.learner_goal,
      canDoStatement: row.gate_can_do_statement,
      sceneContext: row.scene_context,
      hostObjective: row.host_objective,
      completionCriteria: row.completion_criteria,
      hostSeedPrompt: row.host_seed_prompt,
      transitionInstruction: row.transition_instruction,
      aiInstructions: row.gate_ai_instructions,
      hostOpeningText: row.host_opening_text,
    })),
  };
}
