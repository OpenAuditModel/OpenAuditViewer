/**
 * Profile conformance checking for a single event.
 *
 * Ported from conformance/src/profiles/check-profile.ts, adapted the same way
 * lint-event.ts was: schema validation calls this app's own `validateEvent`
 * directly instead of taking an injectable validator.
 *
 * The order is fixed and matters: core validation first, then rule selection,
 * then evaluation. An event that does not conform to the core model is reported
 * as core-invalid and its profile rules are **not** evaluated, because a profile
 * only ever adds requirements to a conforming event. Reporting profile
 * conformance for an event the core rejects would be the one thing a profile
 * must never do.
 */
import { validateEvent as validateAgainstSchema } from "../schema";
import { resolvePointer } from "./resolve-pointer";
import { eventName, selectRules } from "./select-rules";
import { evaluateRule } from "./evaluate-rule";
import {
  supportsCoreVersion,
  type ProfileCheckResult,
  type ProfileDefinition,
  type ProfileFinding,
} from "./types";

export interface CheckProfileOptions {
  /** Validate against the canonical core schema first. Defaults to true. */
  readonly validateCore?: boolean;
}

function eventIdentity(event: unknown): { eventId?: string } {
  const resolved = resolvePointer(event, "/id");
  return typeof resolved.value === "string" ? { eventId: resolved.value } : {};
}

/**
 * Checks one event against one profile.
 *
 * The input event is never modified: every step reads.
 */
export function checkProfile(
  event: unknown,
  label: string,
  profile: ProfileDefinition,
  options: CheckProfileOptions = {},
): ProfileCheckResult {
  const identity = eventIdentity(event);
  const descriptor = { name: profile.name, version: profile.version };

  const base = {
    label,
    ...identity,
    profile: descriptor,
    matchedRules: [] as readonly string[],
    errors: [] as readonly ProfileFinding[],
    warnings: [] as readonly ProfileFinding[],
    coreIssues: [] as readonly string[],
  };

  if (options.validateCore !== false) {
    const issues = validateAgainstSchema(event);
    if (issues.length > 0) {
      const shown = issues.slice(0, 5).map((issue) => `${issue.path}  ${issue.message}`);
      return {
        ...base,
        status: "core-invalid",
        coreValid: false,
        profileValid: false,
        coreIssues:
          issues.length > shown.length
            ? [...shown, `and ${issues.length - shown.length} further core schema issues`]
            : shown,
      };
    }
  }

  // A profile states which core versions it applies to. An event declaring
  // another version is outside its scope, not in violation of it.
  const specVersion = resolvePointer(event, "/specVersion").value;
  if (!supportsCoreVersion(profile, specVersion)) {
    return { ...base, status: "not-applicable", coreValid: true, profileValid: true };
  }

  const name = eventName(event);
  if (name === undefined) {
    return { ...base, status: "not-applicable", coreValid: true, profileValid: true };
  }

  const rules = selectRules(profile, name);
  if (rules.length === 0) {
    return { ...base, status: "not-applicable", coreValid: true, profileValid: true };
  }

  const errors: ProfileFinding[] = [];
  const warnings: ProfileFinding[] = [];

  for (const rule of rules) {
    const evaluation = evaluateRule(event, rule);
    errors.push(...evaluation.errors);
    warnings.push(...evaluation.warnings);
  }

  return {
    ...base,
    status: errors.length === 0 ? "conforming" : "violations",
    coreValid: true,
    profileValid: errors.length === 0,
    matchedRules: rules.map((rule) => rule.id),
    errors,
    warnings,
  };
}
