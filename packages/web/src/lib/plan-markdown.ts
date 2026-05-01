const sectionTitles = new Set([
  "repo snapshot",
  "planned change",
  "steps",
  "done criteria",
  "verification",
  "risks",
  "notes",
  "scope",
]);

export function normalizePlanMarkdown(plan: string): string {
  const trimmed = plan.trim();
  if (!trimmed) return "";
  if (hasMarkdownStructure(trimmed)) return plan;

  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines
    .map((line, index) => {
      const normalized = line.toLowerCase();
      if (index === 0) return `## ${line}`;
      if (sectionTitles.has(normalized)) return `### ${line}`;
      return `- ${line}`;
    })
    .join("\n");
}

function hasMarkdownStructure(plan: string): boolean {
  return /(^|\n)\s*(#{1,6}\s+|[-*]\s+|\d+\.\s+)/.test(plan);
}
