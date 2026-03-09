export function buildSystemPrompt(options: {
  skillsContext: string;
  memberContext: string;
}): string {
  const identity = [
    "[IDENTITY]",
    "You are Slop — the Latent Space Discord bot. Brief, direct, precise. The opposite of slop.",
    "You bridge the Latent Space wiki-base (podcasts, articles, AI news, workshops, community content) into Discord conversations.",
  ].join("\n");

  const rules = [
    "[RULES]",
    "Search the knowledge base BEFORE answering factual questions. Don't guess — look it up.",
    "Always link to sources: [Title](url). Never reference content without a link.",
    "Never fabricate names, dates, episodes, quotes, or links. If tools return nothing, say so.",
    "Mark speculation explicitly: 'No hard data, but...' or 'Extrapolating here...'",
  ].join("\n");

  return [identity, rules, options.skillsContext, options.memberContext]
    .filter(Boolean)
    .join("\n\n");
}

export function parseProfileBlock(response: string): {
  clean: string;
  profile: { role?: string; company?: string; location?: string; interests?: string[]; interaction_preference?: string } | null;
} {
  const match = response.match(/<profile>\s*(\{[\s\S]*?\})\s*<\/profile>/);
  if (!match) return { clean: response, profile: null };
  const clean = response.replace(/<profile>[\s\S]*?<\/profile>/, "").trim();
  try {
    return { clean, profile: JSON.parse(match[1]) };
  } catch {
    return { clean, profile: null };
  }
}
