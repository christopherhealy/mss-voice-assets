import { pool } from "../lib/db.js";

// ============================================================
// Experience context loader
//
// Default:
// - Load the current version of a published Experience.
//
// Authorized GPT Live:
// - Require the exact Experience version and level IDs
//   supplied by Ingle's verified grant redemption.
// - Never silently substitute the current version.
//
// SECURITY:
// Browser-supplied version/level IDs must never be treated
// as authorization. Only pass authoritative grant values
// when creating an authorized Live session.
// ============================================================

function positiveInteger(value) {
  const number = Number(value);

  return Number.isSafeInteger(number) && number > 0
    ? number
    : null;
}

export async function loadExperienceContext({
  experienceKey,
  levelNo = 1,
  experienceVersionId = null,
  experienceLevelId = null,
}) {
  const key = String(experienceKey || "").trim();
  const level = positiveInteger(levelNo);

  if (!key) {
    throw new Error("missing_experience_key");
  }

  if (!level) {
    throw new Error("invalid_level_no");
  }

  // Both IDs must be present for exact-version selection.
  // Supplying only one is not permitted.

  const exactVersionRequested =
    experienceVersionId != null ||
    experienceLevelId != null;

  let versionId = null;
  let levelId = null;

  if (exactVersionRequested) {
    versionId = positiveInteger(experienceVersionId);
    levelId = positiveInteger(experienceLevelId);

    if (!versionId || !levelId) {
      throw new Error(
        "invalid_authorized_experience_context"
      );
    }
  }

  const versionCondition = exactVersionRequested
    ? `
        AND ev.experience_version_id = $3
        AND el.experience_level_id = $4
      `
    : `
        AND ev.status = 'current'
      `;

  const parameters = exactVersionRequested
    ? [key, level, versionId, levelId]
    : [key, level];

  const q = await pool.query(
    `
      SELECT
        e.experience_id,
        e.experience_key,
        e.title AS experience_title,
        e.short_description,
        e.category,

        ev.experience_version_id,
        ev.version_no,
        ev.goal AS experience_goal,
        ev.can_do_statement AS experience_can_do_statement,
        ev.learner_situation,
        ev.host_role,
        ev.scenario_context,
        ev.ai_instructions AS version_ai_instructions,
        ev.estimated_minutes,

        h.host_id,
        h.host_key,
        h.display_name AS host_name,
        h.role_name,
        h.character_brief,
        h.world_rules,
        h.interaction_rules,
        h.voice_key,
        h.gender_style,

        el.experience_level_id,
        el.level_no,
        el.title AS level_title,
        el.difficulty_description,
        el.scenario_modifier,
        el.ai_instructions AS level_ai_instructions,
        el.badge_title,

        g.experience_gate_id,
        g.gate_no,
        g.gate_key,
        g.title AS gate_title,
        g.learner_goal,
        g.can_do_statement AS gate_can_do_statement,
        g.scene_context,
        g.host_objective,
        g.completion_criteria,
        g.host_seed_prompt,
        g.transition_instruction,
        g.ai_instructions AS gate_ai_instructions,
        g.host_opening_text

      FROM experiences e

      JOIN experience_versions ev
        ON ev.experience_id = e.experience_id

      JOIN experience_levels el
        ON el.experience_version_id = ev.experience_version_id
       AND el.level_no = $2

      LEFT JOIN experience_hosts h
        ON h.host_id = ev.host_id

      JOIN experience_gates g
        ON g.experience_level_id = el.experience_level_id

      WHERE e.experience_key = $1
        AND e.status = 'published'

        ${versionCondition}

      ORDER BY g.gate_no ASC
    `,
    parameters
  );

  if (!q.rows.length) {
    const err = new Error(
      exactVersionRequested
        ? "authorized_experience_context_not_found"
        : "experience_context_not_found"
    );

    err.status = 404;
    throw err;
  }

  const first = q.rows[0];

  // Defence in depth: confirm the returned definition
  // matches the explicitly authorized identifiers.

  if (
    exactVersionRequested &&
    (
      Number(first.experience_version_id) !== versionId ||
      Number(first.experience_level_id) !== levelId ||
      Number(first.level_no) !== level
    )
  ) {
    const err = new Error(
      "authorized_experience_context_mismatch"
    );

    err.status = 403;
    throw err;
  }

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
      canDoStatement:
        first.experience_can_do_statement,
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
      difficultyDescription:
        first.difficulty_description,
      scenarioModifier: first.scenario_modifier,
      aiInstructions: first.level_ai_instructions,
      badgeTitle: first.badge_title,
    },

    objectives: q.rows.map((row) => ({
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
