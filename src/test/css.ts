import { readFileSync } from 'node:fs';

// Vitest blanks CSS imports, so tests read the stylesheet as plain text.
export const stylesheet = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');

const bare = stylesheet.replace(/\/\*[\s\S]*?\*\//g, '');

/** The declarations in the rule whose selector is exactly `selector`. */
export function declarations(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = new RegExp(`^${escaped} \\{([^}]*)\\}`, 'm').exec(bare);
  if (!rule) throw new Error(`No rule for ${selector}`);
  const out: Record<string, string> = {};
  for (const m of rule[1].matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
