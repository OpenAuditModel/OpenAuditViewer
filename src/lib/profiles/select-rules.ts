/**
 * Rule selection.
 *
 * Ported verbatim from conformance/src/profiles/select-rules.ts.
 *
 * Selection is by exact event name or by dotted prefix, and by nothing else.
 * There is no regular expression selector: a profile is a published contract
 * about which events it governs, and a pattern language turns "does this rule
 * apply to my event?" into a question only a tool can answer.
 */
import { resolvePointer } from "./resolve-pointer";
import type { ProfileDefinition, ProfileRule } from "./types";

/** Reads `/event/name` from an event, or `undefined`. */
export function eventName(event: unknown): string | undefined {
  const resolved = resolvePointer(event, "/event/name");
  return typeof resolved.value === "string" ? resolved.value : undefined;
}

/** Whether a rule's selector matches an event name. */
export function ruleMatches(rule: ProfileRule, name: string): boolean {
  if (rule.events?.includes(name) === true) {
    return true;
  }
  // Prefixes end with a dot, so `identity.role.` cannot match `identity.roles-export`.
  return rule.eventPrefixes?.some((prefix) => name.startsWith(prefix)) === true;
}

/**
 * Selects the rules that apply to an event name, in definition order.
 *
 * Order is the order the rules appear in the profile document, which makes a
 * report reproducible and reviewable against the definition. A rule matched by
 * both an exact name and a prefix is selected once.
 */
export function selectRules(profile: ProfileDefinition, name: string): ProfileRule[] {
  const selected: ProfileRule[] = [];
  const seen = new Set<string>();

  for (const rule of profile.rules) {
    if (!ruleMatches(rule, name) || seen.has(rule.id)) {
      continue;
    }
    seen.add(rule.id);
    selected.push(rule);
  }

  return selected;
}
