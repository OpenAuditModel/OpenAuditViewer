/**
 * Behavioral tests for the viewer's ported analysis logic. Grown out of the
 * original smoke-test.mjs; the assertions are deliberately rule-ID-precise
 * so that any drift from the OpenAuditModel CLI's behavior fails loudly.
 */
import { describe, expect, it } from "vitest";
import { parseFile } from "../parse";
import { lintEvent } from "../privacy/lint-event";
import { calculateDigest } from "../integrity/digest";
import { verifyEventIntegrity } from "../integrity/verify-event";
import { verifyChains } from "../integrity/chain";
import { ALL_PROFILES, checkProfile } from "../profiles";
import { buildFlowTopology, buildTraceGroups } from "../trace";
import type { LoadedEvent } from "../types";

function minimalEvent(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    specVersion: "0.1",
    id,
    time: "2026-03-14T11:47:52.108Z",
    event: { name: "configuration.setting.update", category: "configuration", outcome: "success" },
    actor: { type: "user", id: "user-1" },
    resource: { type: "configuration", id: "cfg-1" },
    application: { name: "test-app", environment: "production" },
    ...overrides,
  };
}

describe("parseFile", () => {
  it("parses a single valid JSON event and extracts table fields", () => {
    const rows = parseFile(
      "minimal.json",
      JSON.stringify(minimalEvent("018f1b70-2c18-7f3a-b46d-000000000001")),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.valid).toBe(true);
    expect(rows[0]?.eventName).toBe("configuration.setting.update");
  });

  it("reports a schema-invalid event with findings", () => {
    const event = minimalEvent("018f1b70-2c18-7f3a-b46d-000000000002");
    delete event["actor"];
    const rows = parseFile("bad.json", JSON.stringify(event));
    expect(rows[0]?.valid).toBe(false);
    expect(rows[0]?.errors.length).toBeGreaterThan(0);
  });

  it("parses JSONL line by line", () => {
    const line = (id: string) => JSON.stringify(minimalEvent(id));
    const rows = parseFile(
      "events.jsonl",
      `${line("018f1b70-2c18-7f3a-b46d-000000000003")}\n${line("018f1b70-2c18-7f3a-b46d-000000000004")}\n`,
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.valid)).toBe(true);
  });

  it("reports a document that is not an object as unreadable rather than guessing", () => {
    const rows = parseFile("array-of-strings.json", JSON.stringify(["not", "events"]));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.valid === false)).toBe(true);
    expect(rows.every((row) => row.event === null)).toBe(true);
  });
});

describe("privacy linting (ported rules)", () => {
  const base = minimalEvent("018f1b70-2c18-7f3a-b46d-000000000010");

  it("reports a clean event as clean", () => {
    const result = lintEvent(base, "clean.json");
    expect(result.status).toBe("clean");
    expect(result.findings).toHaveLength(0);
  });

  it("flags a populated password field as OAM-PRIV-001 critical, never echoing the value", () => {
    const result = lintEvent(
      { ...base, metadata: { password: "hunter2-not-a-real-secret" } },
      "p.json",
    );
    expect(result.findings[0]?.ruleId).toBe("OAM-PRIV-001");
    expect(result.findings[0]?.severity).toBe("critical");
    expect(JSON.stringify(result.findings)).not.toContain("hunter2");
  });

  it("flags an AWS-shaped access key id as OAM-PRIV-011", () => {
    const result = lintEvent({ ...base, metadata: { note: "AKIAIOSFODNN7EXAMPLE" } }, "aws.json");
    expect(result.findings.some((finding) => finding.ruleId === "OAM-PRIV-011")).toBe(true);
  });

  it("flags a Stripe-shaped secret key as OAM-PRIV-015", () => {
    const result = lintEvent(
      { ...base, metadata: { note: "sk_live_4eC39HqLyjWDarjtT1zdp7dc" } },
      "s.json",
    );
    expect(result.findings.some((finding) => finding.ruleId === "OAM-PRIV-015")).toBe(true);
  });

  it("flags a credentialed connection string as OAM-PRIV-040", () => {
    const result = lintEvent(
      { ...base, metadata: { note: "Server=db1;Database=payments;User Id=admin;Password=s3cr3t" } },
      "c.json",
    );
    expect(result.findings.some((finding) => finding.ruleId === "OAM-PRIV-040")).toBe(true);
  });

  it("does not deep-lint a schema-invalid event", () => {
    const result = lintEvent({ ...base, actor: undefined }, "invalid.json");
    expect(result.status).toBe("schema-invalid");
    expect(result.findings).toHaveLength(0);
  });

  // Buffer-parity cases for the base64url decode (found in security review):
  // Node's Buffer silently drops a dangling character (length ≡ 1 mod 4) and
  // substitutes U+FFFD for invalid UTF-8; atob/fatal TextDecoder would reject
  // both, silently missing JWTs the CLI flags.
  it("flags a JWT whose payload has a dangling base64url character, like the CLI does", () => {
    const value = "eyJhbGciOiJub25lIn0.eyJhYmMiOjd9A.sig";
    const result = lintEvent({ ...base, metadata: { token: value } }, "jwt1.json");
    expect(result.findings.some((finding) => finding.ruleId === "OAM-PRIV-010")).toBe(true);
  });

  it("flags a JWT whose payload contains invalid UTF-8, like the CLI does", () => {
    // {"a":"<0xFF>"} — invalid UTF-8 inside a JSON string; Buffer decodes it
    // with replacement, producing valid JSON.
    const payloadBytes = Uint8Array.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);
    const payload = Buffer.from(payloadBytes).toString("base64url");
    const value = `eyJhbGciOiJub25lIn0.${payload}.sig`;
    const result = lintEvent({ ...base, metadata: { token: value } }, "jwt2.json");
    expect(result.findings.some((finding) => finding.ruleId === "OAM-PRIV-010")).toBe(true);
  });
});

describe("hostile-input resilience", () => {
  it("reports a too-deep structure as a validation issue instead of throwing", async () => {
    let deep: unknown = 1;
    for (let index = 0; index < 100_000; index += 1) {
      deep = [deep];
    }
    const event = minimalEvent("018f1b70-2c18-7f3a-b46d-000000000050", { metadata: { deep } });
    const { validateEvent } = await import("../schema");
    const issues = validateEvent(event);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.message).toContain("nested too deeply");
  });

  it("safeStringify survives structures JSON.stringify cannot serialize", async () => {
    const { safeStringify } = await import("../diff");
    let deep: unknown = 1;
    for (let index = 0; index < 100_000; index += 1) {
      deep = [deep];
    }
    expect(safeStringify(deep, 2)).toContain("too deeply");
    expect(safeStringify({ a: 1 }, 0)).toBe('{"a":1}');
  });
});

describe("integrity: single-event digests", () => {
  const sealedBase = minimalEvent("018f1b70-2c18-7f3a-b46d-000000000020", {
    integrity: { canonicalization: "RFC8785", hashAlgorithm: "SHA-256" },
  });

  it("produces a 64-char lowercase hex SHA-256 digest", async () => {
    const hash = await calculateDigest(sealedBase, "SHA-256");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("verifies a correctly sealed event", async () => {
    const hash = await calculateDigest(sealedBase, "SHA-256");
    const sealed = { ...sealedBase, integrity: { ...(sealedBase["integrity"] as object), hash } };
    const result = await verifyEventIntegrity(sealed, "sealed.json");
    expect(result.verified).toBe(true);
  });

  it("reports hash-mismatch for content edited after sealing", async () => {
    const hash = await calculateDigest(sealedBase, "SHA-256");
    const sealed = { ...sealedBase, integrity: { ...(sealedBase["integrity"] as object), hash } };
    const tampered = { ...sealed, resource: { type: "configuration", id: "cfg-2" } };
    const result = await verifyEventIntegrity(tampered, "tampered.json");
    expect(result.verified).toBe(false);
    expect(result.findings[0]?.kind).toBe("hash-mismatch");
  });

  it("reports integrity-missing when there is nothing to verify", async () => {
    const result = await verifyEventIntegrity(
      minimalEvent("018f1b70-2c18-7f3a-b46d-000000000021"),
      "none.json",
    );
    expect(result.findings[0]?.kind).toBe("integrity-missing");
  });
});

describe("integrity: chains", () => {
  const chainId = "018f1b70-2c18-7f3a-b46d-000000000030";

  async function sealedEvent(id: string, sequence: number, previousHash?: string) {
    const event = minimalEvent(id, {
      sequence,
      integrity: {
        canonicalization: "RFC8785",
        hashAlgorithm: "SHA-256",
        chainId,
        ...(previousHash === undefined ? {} : { previousHash }),
      },
    });
    const hash = await calculateDigest(event, "SHA-256");
    return { ...event, integrity: { ...(event["integrity"] as object), hash } } as Record<
      string,
      unknown
    > & {
      integrity: { hash: string };
    };
  }

  it("verifies an intact three-event chain", async () => {
    const event1 = await sealedEvent("018f1b70-2c18-7f3a-b46d-000000000031", 1);
    const event2 = await sealedEvent(
      "018f1b70-2c18-7f3a-b46d-000000000032",
      2,
      event1.integrity.hash,
    );
    const event3 = await sealedEvent(
      "018f1b70-2c18-7f3a-b46d-000000000033",
      3,
      event2.integrity.hash,
    );
    const report = await verifyChains([
      { label: "e1", event: event1 },
      { label: "e2", event: event2 },
      { label: "e3", event: event3 },
    ]);
    expect(report.intact).toBe(true);
    expect(report.chains[0]?.eventCount).toBe(3);
    expect(report.chains[0]?.firstSequence).toBe(1);
    expect(report.chains[0]?.lastSequence).toBe(3);
  });

  it("detects a broken previous-hash link", async () => {
    const event1 = await sealedEvent("018f1b70-2c18-7f3a-b46d-000000000034", 1);
    // Sealed AFTER the garbage previousHash was set: its own digest is valid,
    // only the link to the predecessor is wrong.
    const event2 = await sealedEvent("018f1b70-2c18-7f3a-b46d-000000000035", 2, "0".repeat(64));
    const report = await verifyChains([
      { label: "e1", event: event1 },
      { label: "e2", event: event2 },
    ]);
    expect(report.intact).toBe(false);
    expect(report.chains[0]?.findings.some((finding) => finding.kind === "broken-link")).toBe(true);
  });

  it("leaves events without a chainId unassigned instead of guessing", async () => {
    const event = minimalEvent("018f1b70-2c18-7f3a-b46d-000000000036", {
      integrity: { canonicalization: "RFC8785", hashAlgorithm: "SHA-256", hash: "0".repeat(64) },
    });
    const report = await verifyChains([{ label: "e1", event }]);
    expect(report.chains).toHaveLength(0);
    expect(report.unassigned[0]?.kind).toBe("chain-id-missing");
  });

  it("reports a schema-invalid chain member as unassigned, not silently dropped", async () => {
    const event1 = await sealedEvent("018f1b70-2c18-7f3a-b46d-000000000037", 1);
    const invalid = {
      ...(await sealedEvent("018f1b70-2c18-7f3a-b46d-000000000038", 2, event1.integrity.hash)),
    } as Record<string, unknown>;
    delete invalid["actor"];
    const report = await verifyChains([
      { label: "e1", event: event1 },
      { label: "e2-invalid", event: invalid },
    ]);
    expect(report.intact).toBe(false);
    expect(report.unassigned.some((finding) => finding.kind === "schema-invalid")).toBe(true);
  });
});

describe("profile conformance (vendored profiles)", () => {
  const incident = ALL_PROFILES.find((profile) => profile.name === "incident-management");

  it("vendors all ten published profiles", () => {
    expect(ALL_PROFILES).toHaveLength(10);
    expect(incident).toBeDefined();
  });

  const governed = minimalEvent("018f1b70-2c18-7f3a-b46d-000000000040", {
    event: { name: "incident.case.create", category: "incident-management", outcome: "success" },
    resource: { type: "incident", id: "inc-1" },
  });

  it("reports violations for a governed event missing requirements", () => {
    const result = checkProfile(governed, "bare.json", incident!);
    expect(result.status).toBe("violations");
    expect(result.errors.some((error) => error.ruleId === "INC-CORE-001")).toBe(true);
  });

  it("reports conforming when authorization and incident metadata are present", () => {
    const complete = {
      ...governed,
      authorization: { decision: "allow" },
      metadata: { incident: { status: "open", priority: "p2" } },
    };
    const result = checkProfile(complete, "complete.json", incident!);
    expect(result.status).toBe("conforming");
  });

  it("reports not-applicable for ungoverned event names", () => {
    const unrelated = {
      ...governed,
      event: { name: "authentication.login", category: "authentication", outcome: "success" },
    };
    expect(checkProfile(unrelated, "u.json", incident!).status).toBe("not-applicable");
  });

  it("does not evaluate rules for a core-invalid event", () => {
    const invalid = { ...governed } as Record<string, unknown>;
    delete invalid["actor"];
    const result = checkProfile(invalid, "invalid.json", incident!);
    expect(result.status).toBe("core-invalid");
    expect(result.errors).toHaveLength(0);
  });
});

describe("trace grouping and topology", () => {
  const trace = "abcdefabcdefabcdefabcdefabcdef12";

  function row(
    id: string,
    time: string,
    app: string,
    name: string,
    request: Record<string, unknown>,
    outcome = "success",
  ): LoadedEvent {
    return {
      rowId: id,
      sourceFile: "t.jsonl",
      sourceFormat: "jsonl",
      valid: true,
      errors: [],
      privacyFindings: [],
      time,
      applicationName: app,
      eventName: name,
      outcome,
      event: { request },
    } as unknown as LoadedEvent;
  }

  it("groups by traceId, merges unambiguous correlation-only events, drops singletons", () => {
    const groups = buildTraceGroups([
      row("r1", "2026-08-05T10:00:00.000Z", "gateway", "route.forward", {
        traceId: trace,
        correlationId: "ord-1",
      }),
      row("r2", "2026-08-05T10:00:01.000Z", "payments", "payment.authorize", { traceId: trace }),
      row("r3", "2026-08-05T10:00:05.000Z", "notifier", "notify.send", { correlationId: "ord-1" }),
      row("r4", "2026-08-05T11:00:00.000Z", "jobs", "job.start", { correlationId: "run-77" }),
      row("r5", "2026-08-05T11:00:09.000Z", "jobs", "job.finish", { correlationId: "run-77" }),
      row("r6", "2026-08-05T12:00:00.000Z", "lonely", "x.y", { correlationId: "solo-1" }),
    ]);

    expect(groups).toHaveLength(2);
    const traceGroup = groups.find((group) => group.kind === "trace");
    expect(traceGroup?.members).toHaveLength(3);
    expect(traceGroup?.applications).toEqual(["gateway", "payments", "notifier"]);
    const corrGroup = groups.find((group) => group.kind === "correlation");
    expect(corrGroup?.members).toHaveLength(2);
    expect(groups.every((group) => group.members.length >= 2)).toBe(true);
  });

  it("keeps edges intact for application names containing spaces", () => {
    const groups = buildTraceGroups([
      row("s1", "2026-08-05T10:00:00.000Z", "billing service", "op.start", { traceId: trace }),
      row("s2", "2026-08-05T10:00:01.000Z", "auth", "op.step", { traceId: trace }),
    ]);
    const topology = buildFlowTopology(groups);
    expect(topology.edges).toHaveLength(1);
    expect(topology.edges[0]?.from).toBe("billing service");
    expect(topology.edges[0]?.to).toBe("auth");
  });

  it("does not merge correlation-only events when the correlationId spans several traces", () => {
    const traceA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const traceB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const groups = buildTraceGroups([
      row("a1", "2026-08-05T10:00:00.000Z", "app1", "op.start", {
        traceId: traceA,
        correlationId: "inc-9",
      }),
      row("a2", "2026-08-05T10:00:01.000Z", "app2", "op.step", { traceId: traceA }),
      row("b1", "2026-08-05T14:00:00.000Z", "app1", "op.retry", {
        traceId: traceB,
        correlationId: "inc-9",
      }),
      row("b2", "2026-08-05T14:00:02.000Z", "app2", "op.step", { traceId: traceB }),
      row("c1", "2026-08-05T15:00:00.000Z", "notifier", "notify.page", { correlationId: "inc-9" }),
      row("c2", "2026-08-05T15:00:30.000Z", "notifier", "notify.ack", { correlationId: "inc-9" }),
    ]);

    const traceGroups = groups.filter((group) => group.kind === "trace");
    const corrGroup = groups.find((group) => group.kind === "correlation");
    expect(traceGroups.every((group) => group.members.length === 2)).toBe(true);
    expect(corrGroup?.key).toBe("inc-9");
    expect(corrGroup?.members).toHaveLength(2);

    // Topology aggregates the identical hop from both traces into one edge
    // with the median of both gaps (1000ms, 2000ms -> 1500ms).
    const topology = buildFlowTopology(groups);
    expect(topology.edges).toHaveLength(1);
    expect(topology.edges[0]?.count).toBe(2);
    expect(topology.edges[0]?.medianDeltaMs).toBe(1500);
    expect(topology.apps.find((app) => app.name === "app1")?.depth).toBe(0);
    expect(topology.apps.find((app) => app.name === "app2")?.depth).toBe(1);
  });
});
