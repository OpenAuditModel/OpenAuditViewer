/**
 * Validates a parsed event against the canonical OpenAuditModel schema of the
 * version it declares, as published in `@openauditmodel/cli` at the version
 * package.json pins.
 *
 * The validator is PRECOMPILED at build time (tools/generate-validator.mjs)
 * rather than compiled from the schema at startup. Ajv builds validators
 * with `new Function`, which the app's Content-Security-Policy forbids —
 * and weakening the policy to allow runtime code generation, in an app
 * whose whole job is opening untrusted files, would be the wrong trade.
 * Precompiling also keeps the Ajv compiler out of the shipped bundle.
 *
 * Errors are mapped through the same format-errors translation the CLI uses and
 * are returned in the same shape, so an invalid file reports the same JSON
 * Pointer, the same wording and the same detail here as it does under
 * `openauditmodel validate`. How an issue is laid out on screen is the detail
 * panel's business, not this function's: narrowing it here is what made the two
 * disagree in the first place.
 *
 * Ajv recurses the instance; a value nested a few thousand levels deep
 * overflows the stack. `JSON.parse` imposes no depth limit of its own, so a
 * hostile file CAN put such a value in front of the validator — the throw
 * is caught and reported as an ordinary validation failure instead of being
 * allowed to take down whichever caller happened to validate first.
 */
import validate01 from "../schema/validate-0.1.generated.js";
import validate10 from "../schema/validate-1.0.generated.js";
import { toIssues } from "@openauditmodel/cli/conformance/format-errors.js";
import {
  createVersionedValidator,
  schemaIdFor,
  type EventValidator,
  type SupportedSpecVersion,
} from "@openauditmodel/cli/conformance/validator-interface.js";
import type { ValidationIssue } from "./types";

type CompiledValidator = typeof validate01;

/** One version's precompiled validator, guarded the way the comment above describes. */
function guarded(validateFn: CompiledValidator): (event: unknown) => ValidationIssue[] {
  return (event) => {
    let valid: boolean;
    try {
      valid = validateFn(event);
    } catch (cause) {
      // Only a stack overflow is attributable to the document. Anything else
      // is a defect in this app, and saying "nested too deeply" about it would
      // send whoever reads the report looking at their data instead of at us.
      if (cause instanceof RangeError) {
        return [
          { path: "/", message: "structure is nested too deeply to validate", keyword: "reader" },
        ];
      }
      return [
        {
          path: "/",
          message: `the validator failed unexpectedly: ${(cause as Error).message}`,
          keyword: "reader",
        },
      ];
    }
    return valid ? [] : toIssues(validateFn.errors);
  };
}

/**
 * Selects the schema by the version an event declares, with the package's own
 * selection logic (ADR 0017), so an event the CLI does not evaluate is not
 * evaluated here either — reported under the same keyword, never as valid.
 */
const versioned = createVersionedValidator(
  new Map<SupportedSpecVersion, EventValidator>([
    ["0.1", { schemaId: schemaIdFor("0.1"), validateEvent: guarded(validate01) }],
    ["1.0", { schemaId: schemaIdFor("1.0"), validateEvent: guarded(validate10) }],
  ]),
);

export function validateEvent(event: unknown): ValidationIssue[] {
  return versioned.validateEvent(event);
}
