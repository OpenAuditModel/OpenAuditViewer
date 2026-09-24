/**
 * The published analysis engines, bound to this app's validator.
 *
 * Privacy linting and profile conformance are not implemented here: they are
 * `@openauditmodel/cli`'s, pinned to an exact version, so that this app cannot
 * drift from the tool it claims to agree with. What used to be ~2,200 lines of
 * ported engine is now this file.
 *
 * The one thing that stays local is the validator. The CLI validates against
 * whatever schema path the caller resolved; this app has exactly one schema,
 * compiled at build time because Ajv builds validators with `new Function` and
 * the Content-Security-Policy forbids that. The engines take a validator as a
 * parameter precisely so both can be true, and binding it here is what keeps
 * every call site from threading it through.
 *
 * Integrity stays forked in `./integrity` — Web Crypto is asynchronous where
 * Node's `createHash` is not, which is a real difference rather than drift.
 * Nothing in this file reaches the filesystem: the package's profile loaders,
 * which do, are deliberately not imported.
 */
import { lintEvent as lintWithValidator } from "@openauditmodel/cli/conformance/privacy/lint-event.js";
import type { LintOptions } from "@openauditmodel/cli/conformance/privacy/lint-event.js";
import { checkProfile as checkWithValidator } from "@openauditmodel/cli/conformance/profiles/check-profile.js";
import type { CheckProfileOptions } from "@openauditmodel/cli/conformance/profiles/check-profile.js";
import type { EventLintResult } from "@openauditmodel/cli/conformance/privacy/types.js";
import type {
  ProfileCheckResult,
  ProfileDefinition,
} from "@openauditmodel/cli/conformance/profiles/types.js";

import { validateEvent } from "./schema";
import canonicalSchema from "@openauditmodel/cli/schemas/v1.0/audit-event.schema.json";

/** This app's precompiled validator, in the shape the engines take. */
const validator = { schemaId: canonicalSchema.$id, validateEvent };

/** Reports values shaped like credentials, and payloads that were not minimized. */
export function lintEvent(
  event: unknown,
  label: string,
  options: LintOptions = {},
): EventLintResult {
  return lintWithValidator(event, label, validator, options);
}

/** Checks one event against one profile. */
export function checkProfile(
  event: unknown,
  label: string,
  profile: ProfileDefinition,
  options: CheckProfileOptions = {},
): ProfileCheckResult {
  return checkWithValidator(event, label, profile, validator, options);
}
