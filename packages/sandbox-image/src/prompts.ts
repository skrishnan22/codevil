export function planPrompt(prompt: string): string {
  return [
    "You are in PLAN MODE.",
    "Explore this repository and create a detailed implementation plan.",
    "Also identify the best dev server for live preview. Do not start it.",
    "If there is a relevant UI dev server, include a JSON object anywhere in your response with this exact shape:",
    "{\"preview\":{\"cwd\":\"relative/path/or/.\",\"command\":\"command to run\",\"port\":5173}}",
    "The preview command must bind to 0.0.0.0 and use a non-3000 port.",
    "Only output the plan as structured markdown.",
    "",
    prompt,
  ].join("\n");
}

export function refinePrompt(feedback: string): string {
  return [
    "Revise the existing plan based on this feedback.",
    "Only output the updated plan as structured markdown.",
    "",
    feedback,
  ].join("\n");
}

export function executePrompt(plan: string): string {
  return [
    "Execute this approved plan step by step.",
    "Make the required code changes, then stop.",
    "Do not run dependency installation, CI, test, or lint commands unless the user explicitly asked for that command.",
    "Codevil will run setup and verification after you stop.",
    "",
    plan,
  ].join("\n");
}

export function repairPrompt(attempt: number, maxAttempts: number, failure: string): string {
  return [
    `Verification failed after attempt ${attempt}/${maxAttempts}.`,
    "Fix the failure, keep changes scoped to the approved plan, then stop.",
    "",
    failure,
  ].join("\n");
}
