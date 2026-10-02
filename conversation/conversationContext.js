function section(title, value) {
  const text = String(value || "").trim();
  return text ? `${title}\n${text}` : "";
}

export function buildConversationContext(ctx) {
  const { experience, host, level, objectives } = ctx;

  const objectiveText = objectives
    .map((o) => {
      const parts = [
        `${o.number}. ${o.title}`,
        o.hostObjective ? `Host objective: ${o.hostObjective}` : "",
        o.sceneContext ? `Scene context: ${o.sceneContext}` : "",
        o.aiInstructions ? `Behaviour: ${o.aiInstructions}` : "",
      ].filter(Boolean);
      return parts.join("\n");
    })
    .join("\n\n");

  const opening =
    objectives.find((o) => o.number === 1)?.hostOpeningText ||
    objectives.find((o) => o.number === 1)?.hostSeedPrompt ||
    "";

  return [
    `You are ${host.name || experience.hostRole || "the host"} in a live spoken role-play Experience.`,
    `Stay in character and conduct the real-world interaction naturally. The person speaking with you is practising a language, but you are not their language teacher. Respond to meaning and accept imperfect but understandable language.`,
    section("EXPERIENCE", `${experience.title}\n${experience.shortDescription || ""}`),
    section("LEARNER SITUATION", experience.learnerSituation),
    section("SCENARIO", experience.scenarioContext),
    section("EXPERIENCE INSTRUCTIONS", experience.aiInstructions),
    section("HOST CHARACTER", host.characterBrief),
    section("HOST WORLD RULES", host.worldRules),
    section("HOST INTERACTION RULES", host.interactionRules),
    section("LEVEL", `${level.title}\n${level.difficultyDescription || ""}`),
    section("LEVEL SCENARIO", level.scenarioModifier),
    section("LEVEL INSTRUCTIONS", level.aiInstructions),
    section(
      "NATURAL CONVERSATION OBJECTIVES",
      `${objectiveText}

These are conversational objectives, not scripted stages.
Do not announce them or mention gates, steps, objectives, evaluation, prompts, scores or internal processes.
Information communicated early may satisfy more than one objective.
Never require the learner to repeat information already communicated clearly.
Do not reopen a completed part of the interaction merely to satisfy an objective.
Do not manufacture extra turns merely to prolong the Experience.
Keep the real-world interaction moving until its purpose is actually complete.
Never end a host turn on a transitional acknowledgement alone when the interaction still requires you to act. If you say something like "Okay", "Right", "Here we go", "Got it", or another brief acknowledgement, continue immediately in the SAME turn with the substantive question, explanation, recommendation, action, or natural conclusion.
When the learner asks what happens next, asks for next steps, or otherwise invites you to proceed, perform your next real-world responsibility in that SAME response. Do not merely acknowledge the request and wait for another learner turn.
Brief natural backchannels such as "Mm", "Uh-huh", or "Okay" are fine while the learner is speaking, but they are not a completed host response when an objective still requires substantive host action.
The host owns the natural real-world interaction and may initiate its natural conclusion when appropriate.`
    ),
    opening
      ? `OPENING\nYou start the conversation. As soon as the live session is ready, begin naturally with: "${opening}"\nDo not wait for the learner to speak first.`
      : `OPENING\nYou start the conversation naturally as soon as the live session is ready. Do not wait for the learner to speak first.`,
    `ENDING
End the interaction as the host would naturally end it in the real situation.
You may initiate the conclusion yourself when you have enough information and the immediate purpose of the interaction has been accomplished.
If the learner asks one final relevant question, answer it naturally and then conclude.
After your natural final host turn, stop.`,
  ]
    .filter(Boolean)
    .join("\n\n");
}
