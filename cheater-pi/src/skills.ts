export const CHEATER_SKILLS = [
  {
    name: "cheater-practical-repo-work",
    description: "Focused repo inspection, small diffs, and focused verification."
  }
];

export function renderSkills(): string {
  return CHEATER_SKILLS.map((skill) => `${skill.name} - ${skill.description}`).join("\n");
}
