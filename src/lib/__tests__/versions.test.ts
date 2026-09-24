/**
 * Which schema an event is judged by, and what happens when there is none.
 *
 * ADR 0017: a validator selects the schema by the version an event declares,
 * and does not evaluate an event of a version it does not implement. The app
 * validates with its own precompiled validators, one per version, so this file
 * holds them to the CLI's answers for every kind of declared version — the
 * CLI's validator is compiled from the same schemas in the same package.
 */
import { describe, expect, it } from "vitest";
import { createValidator } from "@openauditmodel/cli/conformance/validate.js";
import { NOT_EVALUATED_KEYWORD } from "@openauditmodel/cli/conformance/validator-interface.js";
import { validateEvent } from "../schema";
import { parseJsonLine } from "../parse";

const cli = createValidator();

function event(specVersion: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    specVersion,
    id: "018f1b70-2c18-7f3a-b46d-000000000900",
    time: "2026-09-23T10:00:00.000Z",
    event: { name: "data.record.update", category: "data-modification", outcome: "success" },
    actor: { type: "user", id: "user-1" },
    resource: { type: "record", id: "record-1" },
    application: { name: "versions-test", environment: "test" },
    ...extra,
  };
}

const DECLARED: readonly unknown[] = [
  "0.1",
  "1.0",
  "1.1",
  "2.0",
  "0.2",
  "1",
  "v1.0",
  " 1.0",
  1,
  null,
];

describe("versions", () => {
  it.each(DECLARED.map((declared) => [JSON.stringify(declared), declared] as const))(
    "specVersion %s is judged exactly as the CLI judges it",
    (_label, declared) => {
      const subject = event(declared);
      const ours = validateEvent(subject).map((issue) => `${issue.path} ${issue.keyword}`);
      const theirs = cli.validateEvent(subject).map((issue) => `${issue.path} ${issue.keyword}`);
      expect(ours).toEqual(theirs);
    },
  );

  it("a field added in 1.0 is judged by the schema the event declares", () => {
    const withParent = {
      request: { spanId: "00f067aa0ba902b7", parentSpanId: "0af7651916cd43dd" },
    };
    expect(validateEvent(event("1.0", withParent))).toEqual([]);
    expect(validateEvent(event("0.1", withParent)).map((issue) => issue.path)).toEqual([
      "/request/parentSpanId",
    ]);
  });

  it("a row of a version the app does not implement is neither valid nor invalid", () => {
    const row = parseJsonLine("a.jsonl", JSON.stringify(event("1.1")), 1);
    if (row === undefined) throw new Error("no row");
    expect(row.valid).toBe(false);
    expect(row.notEvaluated).toBe(true);
    expect(row.errors.map((issue) => issue.keyword)).toEqual([NOT_EVALUATED_KEYWORD]);
    // Not deep-linted: nothing about its structure was established.
    expect(row.privacyFindings).toEqual([]);

    const malformed = parseJsonLine("a.jsonl", JSON.stringify(event("v1")), 2);
    if (malformed === undefined) throw new Error("no row");
    expect(malformed.valid).toBe(false);
    expect(malformed.notEvaluated).toBe(false);
  });
});
