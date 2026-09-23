/**
 * Behavioral tests for the viewer's ported analysis logic. Grown out of the
 * original smoke-test.mjs; the assertions are deliberately rule-ID-precise
 * so that any drift from the OpenAuditModel CLI's behavior fails loudly.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isJsonLines, parseFile, parseJsonLine } from "../parse";
import { lintEvent } from "../engines";
import { calculateDigest } from "../integrity/digest";
import { verifyEventIntegrity } from "../integrity/verify-event";
import { verifyChains } from "../integrity/chain";
import { ALL_PROFILES, checkProfile } from "../profiles";
import { governsNothing, summariseArchiveCoverage } from "../coverage";
import { compareVersions, compareWithRelease, parseVersion } from "../update";
import { buildArchiveReport } from "../report";
import { triage } from "../triage";
import { buildFlowTopology, buildTraceGroups } from "../trace";
import type { LoadedEvent, LoadSummary } from "../types";

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

  // The loader streams JSON Lines a line at a time rather than splitting a
  // whole file, so the per-line parser has to agree with the whole-text one.
  it("parses a line on its own exactly as it would within a whole file", () => {
    const line = JSON.stringify(minimalEvent("018f1b70-2c18-7f3a-b46d-000000000060"));
    const whole = parseFile("stream.jsonl", `${line}\n`);
    const single = parseJsonLine("stream.jsonl", line, 1);

    expect(single).toBeDefined();
    expect(single?.valid).toBe(whole[0]?.valid);
    expect(single?.eventName).toBe(whole[0]?.eventName);
    expect(single?.privacyFindings.length).toBe(whole[0]?.privacyFindings.length);
  });

  it("treats a blank line as carrying no event", () => {
    expect(parseJsonLine("stream.jsonl", "   ", 4)).toBeUndefined();
    expect(parseJsonLine("stream.jsonl", "", 5)).toBeUndefined();
  });

  it("names the line a malformed record came from", () => {
    const row = parseJsonLine("stream.jsonl", "{ not json", 7);
    expect(row?.valid).toBe(false);
    expect(row?.errors[0]?.message).toContain("line 7");
  });

  it("recognizes which extensions are read line by line", () => {
    expect(isJsonLines("a.jsonl")).toBe(true);
    expect(isJsonLines("a.NDJSON")).toBe(true);
    expect(isJsonLines("a.json")).toBe(false);
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

describe("profile conformance (the published profiles)", () => {
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

describe("archive coverage", () => {
  /** A loaded row wrapping an event, as the table holds it. */
  function loaded(id: string, event: Record<string, unknown>, valid = true): LoadedEvent {
    return {
      rowId: id,
      sourceFile: "archive.jsonl",
      sourceFormat: "jsonl",
      event,
      valid,
      errors: [],
      privacyFindings: [],
      eventName: (event["event"] as Record<string, unknown> | undefined)?.["name"] as
        string | undefined,
    };
  }

  const incidentRow = loaded(
    "r1",
    minimalEvent("018f1b70-2c18-7f3a-b46d-000000000050", {
      event: { name: "incident.case.create", category: "incident-management", outcome: "success" },
      resource: { type: "incident", id: "inc-1" },
    }),
  );
  const conformingIncident = loaded(
    "r2",
    minimalEvent("018f1b70-2c18-7f3a-b46d-000000000051", {
      event: { name: "incident.case.create", category: "incident-management", outcome: "success" },
      resource: { type: "incident", id: "inc-2" },
      authorization: { decision: "allow" },
      metadata: { incident: { status: "open", priority: "p2" } },
    }),
  );
  // `configuration.setting.update`, the default here, is governed by a real
  // profile — a name outside every selector is needed to test the other case.
  const ungoverned = loaded(
    "r3",
    minimalEvent("018f1b70-2c18-7f3a-b46d-000000000052", {
      event: { name: "catalogue.item.reprice", category: "data-modification", outcome: "success" },
      resource: { type: "catalogue-item", id: "sku-1" },
    }),
  );

  it("counts what each profile governed, conformed and violated", () => {
    const report = summariseArchiveCoverage([incidentRow, conformingIncident, ungoverned]);
    expect(report.checked).toBe(3);
    expect(report.unparsed).toBe(0);

    const incident = report.profiles.find(
      (entry) => entry.coverage.profile.name === "incident-management",
    );
    expect(incident?.coverage.events.conforming).toBe(1);
    expect(incident?.coverage.events.violations).toBe(1);
    expect(incident?.coverage.events.notApplicable).toBe(1);
    expect(incident?.governed.map((entry) => entry.row.rowId)).toEqual(["r1", "r2"]);
  });

  it("reports a profile that reached nothing as governing nothing, never as conforming", () => {
    const report = summariseArchiveCoverage([ungoverned]);
    for (const entry of report.profiles) {
      expect(entry.coverage.nameTotals.governed, entry.coverage.profile.name).toBe(0);
      expect(entry.coverage.events.conforming, entry.coverage.profile.name).toBe(0);
      expect(entry.coverage.events.notApplicable, entry.coverage.profile.name).toBe(1);
      expect(entry.governed).toEqual([]);
    }
    expect(governsNothing(report)).toBe(true);
  });

  it("offers a core-invalid row to every profile, and counts it as core-invalid", () => {
    // The CLI's check-coverage is handed every document and counts
    // `core-invalid` itself, so withholding those rows made this tab's
    // counters differ from the tool it claims to agree with.
    const broken = { ...minimalEvent("018f1b70-2c18-7f3a-b46d-000000000053") };
    delete broken["actor"];
    const report = summariseArchiveCoverage([incidentRow, loaded("r4", broken, false)]);

    expect(report.checked).toBe(2);
    expect(report.unparsed).toBe(0);
    for (const entry of report.profiles) {
      expect(entry.coverage.events.coreInvalid, entry.coverage.profile.name).toBe(1);
      // And it never counts as governed: no rule is evaluated for it.
      expect(entry.governed.some((g) => g.row.rowId === "r4")).toBe(false);
    }
  });

  it("covers every profile this build evaluates, in its order", () => {
    const report = summariseArchiveCoverage([incidentRow]);
    expect(report.profiles.map((entry) => entry.coverage.profile.name)).toEqual(
      ALL_PROFILES.map((profile) => profile.name),
    );
  });

  it("agrees with checkProfile for every governed row", () => {
    // The tab must not become a second opinion: the numbers it shows are the
    // per-event engine's, grouped.
    const report = summariseArchiveCoverage([incidentRow, conformingIncident, ungoverned]);
    for (const entry of report.profiles) {
      const definition = ALL_PROFILES.find(
        (profile) => profile.name === entry.coverage.profile.name,
      );
      for (const { row, result } of entry.governed) {
        const direct = checkProfile(row.event, row.sourceFile, definition!, {
          validateCore: false,
        });
        expect(direct.status).toBe(result.status);
        expect(direct.errors.map((error) => error.ruleId)).toEqual(
          result.errors.map((error) => error.ruleId),
        );
      }
    }
  });
});

describe("update check", () => {
  it("orders versions numerically, so 0.10.0 is newer than 0.9.0", () => {
    // String comparison puts 0.10.0 before 0.9.0, which is the classic way a
    // version check tells someone they are current while they are behind.
    expect(compareVersions([0, 10, 0], [0, 9, 0])).toBeGreaterThan(0);
    expect(compareVersions([1, 0, 0], [0, 99, 99])).toBeGreaterThan(0);
    expect(compareVersions([0, 5], [0, 5, 0])).toBe(0);
    expect(compareVersions([0, 5, 1], [0, 5, 2])).toBeLessThan(0);
  });

  it("reads a tag with or without its v, and refuses anything else", () => {
    expect(parseVersion("v0.5.1")).toEqual([0, 5, 1]);
    expect(parseVersion(" 0.5.1 ")).toEqual([0, 5, 1]);
    for (const bad of ["", "nightly", "0.5.1-rc.1", "v", "0.5.x", "2026-09-20"]) {
      expect(parseVersion(bad), bad).toBeUndefined();
    }
  });

  it("reports behind, current and ahead", () => {
    const release = (tag: string) => ({ tag, url: "https://github.com/o/r/releases/tag/" + tag });

    expect(compareWithRelease("0.4.0", release("v0.5.1"))).toEqual({
      status: "behind",
      current: "0.4.0",
      latest: "v0.5.1",
      url: "https://github.com/o/r/releases/tag/v0.5.1",
    });
    expect(compareWithRelease("0.5.1", release("v0.5.1"))).toEqual({
      status: "current",
      version: "0.5.1",
    });
    expect(compareWithRelease("0.6.0", release("v0.5.1")).status).toBe("ahead");
  });

  it("reports an unreadable answer as failed, never as up to date", () => {
    // The check exists to say whether this build is behind. An answer it
    // cannot read is not an answer that it is not.
    const state = compareWithRelease("0.5.1", {
      tag: "nightly-2026-09-20",
      url: "https://github.com/o/r",
    });
    expect(state.status).toBe("failed");
    expect(state.status === "failed" && state.message).toContain("nightly-2026-09-20");

    expect(compareWithRelease("…", { tag: "v0.5.1", url: "u" }).status).toBe("failed");
  });
});

describe("archive report", () => {
  function loaded(
    id: string,
    event: Record<string, unknown> | null,
    overrides: Partial<LoadedEvent> = {},
  ): LoadedEvent {
    return {
      rowId: id,
      sourceFile: "a.jsonl",
      sourceFormat: "jsonl",
      event,
      valid: event !== null,
      errors: [],
      privacyFindings: [],
      ...overrides,
    };
  }

  const summary = {
    filesRead: 2,
    filesFound: 3,
    filesFailed: [{ path: "broken.json", reason: "unreadable" }],
    filesSkipped: [],
    directoriesSkipped: [],
    directoriesFailed: [],
    truncated: false,
    eventLimit: 100000,
  } as unknown as LoadSummary;

  it("counts the archive, the validity and the privacy findings it was given", async () => {
    const clean = loaded("r1", minimalEvent("018f1b70-2c18-7f3a-b46d-000000000060"));
    const broken = loaded("r2", null, { valid: false, sourceFile: "bad.jsonl" });
    const flagged = loaded("r3", minimalEvent("018f1b70-2c18-7f3a-b46d-000000000061"), {
      privacyFindings: [
        {
          ruleId: "OAM-PRIV-001",
          severity: "critical",
          confidence: "high",
          category: "credential",
          path: "/metadata/password",
          message: "looks like a credential",
        },
      ] as LoadedEvent["privacyFindings"],
    });

    const report = await buildArchiveReport([clean, broken, flagged], summary, "/logs");

    expect(report.archive.events).toBe(3);
    expect(report.archive.folder).toBe("/logs");
    expect(report.archive.unreadableFiles).toBe(1);
    expect(report.validity.valid).toBe(2);
    expect(report.validity.invalid).toBe(1);
    expect(report.validity.worstFiles).toEqual([{ file: "bad.jsonl", invalid: 1 }]);
    expect(report.privacy.findings).toBe(1);
    expect(report.privacy.eventsAffected).toBe(1);
    expect(report.privacy.bySeverity.critical).toBe(1);
    expect(report.privacy.byRule).toEqual([{ ruleId: "OAM-PRIV-001", count: 1 }]);
  });

  /** Seals an event the way a producer would, through this app's own digest path. */
  async function seal(
    id: string,
    sequence: number,
    previousHash?: string,
  ): Promise<Record<string, unknown>> {
    const event = minimalEvent(id, {
      sequence,
      integrity: {
        canonicalization: "RFC8785",
        hashAlgorithm: "SHA-256",
        chainId: "chain-report-1",
        ...(previousHash === undefined ? {} : { previousHash }),
      },
    });
    const hash = await calculateDigest(event, "SHA-256");
    return { ...event, integrity: { ...(event["integrity"] as object), hash } };
  }

  it("reports a chain whose tail was deleted as intact, which is what the limits section is for", async () => {
    // The report must not quietly imply completeness. The engine says intact,
    // because a chain whose most recent entries were removed is internally
    // consistent, and the page says in prose what that does not establish.
    const first = await seal("018f1b70-2c18-7f3a-b46d-000000000071", 1);
    const second = await seal(
      "018f1b70-2c18-7f3a-b46d-000000000072",
      2,
      (first["integrity"] as { hash: string }).hash,
    );
    // A third event existed and is not here; nothing internal can see that.
    const report = await buildArchiveReport(
      [loaded("c1", first), loaded("c2", second)],
      summary,
      undefined,
    );

    expect(report.integrity.declared).toBe(2);
    expect(report.integrity.verified).toBe(2);
    expect(report.integrity.failed).toEqual([]);
    expect(report.integrity.chains).toEqual({
      checked: 1,
      intact: 1,
      unassigned: 0,
      allIntact: true,
    });
  });

  it("counts chain members that could not be verified, so the page can say so", async () => {
    // A chain member the core schema rejects is unassigned rather than
    // broken, and the chain it belonged to is not established. A page that
    // printed "1 chain intact" and stopped there would be claiming more than
    // was checked.
    const sealed = await seal("018f1b70-2c18-7f3a-b46d-000000000074", 1);
    const broken = { ...sealed } as Record<string, unknown>;
    delete broken["actor"];

    const report = await buildArchiveReport(
      [loaded("c1", sealed), loaded("c2", broken, { valid: false })],
      summary,
      undefined,
    );

    expect(report.integrity.chains?.unassigned).toBe(1);
    expect(report.integrity.chains?.allIntact).toBe(false);
  });

  it("says which key its signatures were checked with, or that none was", async () => {
    const sealed = await seal("018f1b70-2c18-7f3a-b46d-000000000077", 1);
    const signed = structuredClone(sealed);
    // The signature sits outside the digest input, so the hash still holds.
    (signed["integrity"] as Record<string, unknown>)["signature"] = {
      algorithm: "Ed25519",
      value: "A".repeat(86) + "==",
    };
    const rows = [loaded("s1", signed)];

    const unchecked = await buildArchiveReport(rows, summary, undefined);
    expect(unchecked.integrity.signatures).toEqual({ declared: 1, checkedWith: undefined });
    expect(unchecked.integrity.verified).toBe(1);

    const refusing = {
      key: {
        keyType: "ed25519",
        fingerprint: "ab".repeat(32),
        fileName: "producer.pem",
        usableFor: ["Ed25519"],
      },
      verify: async () => ({
        ok: false as const,
        kind: "signature-invalid" as const,
        message: "signature does not match",
      }),
    };
    const checked = await buildArchiveReport(rows, summary, undefined, refusing);
    expect(checked.integrity.signatures.checkedWith).toEqual({
      keyType: "ed25519",
      fingerprint: "ab".repeat(32),
      fileName: "producer.pem",
    });
    expect(checked.integrity.verified).toBe(0);
    expect(checked.integrity.failed).toEqual([{ label: "s1", kinds: ["signature-invalid"] }]);
    // The declared value is not something the page prints, so it is not carried.
    expect(JSON.stringify(checked)).not.toContain("A".repeat(86));
  });

  it("verifies a chain's signatures with the key too", async () => {
    // The report's chain path, not only its per-event path, must use the key:
    // a chain whose signatures fail under it is not intact in the report.
    const first = await seal("018f1b70-2c18-7f3a-b46d-000000000078", 1);
    const signed = structuredClone(first);
    (signed["integrity"] as Record<string, unknown>)["signature"] = {
      algorithm: "Ed25519",
      value: "A".repeat(86) + "==",
    };
    const refusing = {
      key: {
        keyType: "ed25519",
        fingerprint: "cd".repeat(32),
        fileName: "producer.pem",
        usableFor: ["Ed25519"],
      },
      verify: async () => ({
        ok: false as const,
        kind: "signature-invalid" as const,
        message: "signature does not match",
      }),
    };
    const withoutKey = await buildArchiveReport([loaded("k1", signed)], summary, undefined);
    expect(withoutKey.integrity.chains?.allIntact).toBe(true);
    const withKey = await buildArchiveReport([loaded("k1", signed)], summary, undefined, refusing);
    expect(withKey.integrity.chains?.allIntact).toBe(false);
  });

  it("carries only the counts of a chain report, never its identifiers or digests", async () => {
    // A ChainReport holds producer-declared chain identifiers, every member's
    // declared and calculated digest, and finding detail lines. None of it is
    // printed, and all of it used to ride along in this structure.
    const first = await seal("018f1b70-2c18-7f3a-b46d-000000000075", 1);
    const report = await buildArchiveReport([loaded("c1", first)], summary, undefined);
    const rendered = JSON.stringify(report);

    expect(rendered).not.toContain("chain-report-1");
    expect(rendered).not.toContain((first["integrity"] as { hash: string }).hash);
  });

  it("counts an event the core schema rejects as failed, as verify-integrity does", async () => {
    // The report is not handed pre-validated rows, so it validates. Printing a
    // core-invalid event under "Digests verified" would claim something the
    // CLI does not: `verify-integrity` fails it as schema-invalid.
    const sealed = await seal("018f1b70-2c18-7f3a-b46d-000000000076", 1);
    const broken = { ...sealed } as Record<string, unknown>;
    delete broken["actor"];

    const report = await buildArchiveReport(
      [loaded("cx", broken, { valid: false })],
      summary,
      undefined,
    );
    expect(report.integrity.verified).toBe(0);
    expect(report.integrity.failed).toEqual([{ label: "cx", kinds: ["schema-invalid"] }]);
  });

  it("counts the same events as the Overview: those declaring a hash", async () => {
    // Two tabs must not give different answers about one folder. An integrity
    // object with no hash is nothing to verify, and the Overview offers no
    // sweep for it.
    const noHash = minimalEvent("018f1b70-2c18-7f3a-b46d-000000000077", {
      integrity: { canonicalization: "RFC8785", hashAlgorithm: "SHA-256" },
    });
    const report = await buildArchiveReport([loaded("r1", noHash)], summary, undefined);
    expect(report.integrity.declared).toBe(0);
    expect(report.integrity.failed).toEqual([]);
  });

  it("names the events whose digests failed, by row and finding kind, never by content", async () => {
    const sealed = await seal("018f1b70-2c18-7f3a-b46d-000000000073", 1);
    const tampered = {
      ...sealed,
      resource: { type: "configuration", id: "secret-looking-marker" },
    };

    const report = await buildArchiveReport([loaded("c9", tampered)], summary, undefined);

    expect(report.integrity.verified).toBe(0);
    expect(report.integrity.failed).toEqual([{ label: "c9", kinds: ["hash-mismatch"] }]);
  });

  it("carries the profiles that were refused, not only the ones evaluated", async () => {
    const report = await buildArchiveReport(
      [loaded("r1", minimalEvent("018f1b70-2c18-7f3a-b46d-000000000080"))],
      summary,
      undefined,
    );
    // None today, and the shape is what the page prints when there is one.
    expect(Array.isArray(report.refusedProfiles)).toBe(true);
    expect(report.profiles.length).toBe(10);
  });

  it("carries no event content at all, because a printed page travels", async () => {
    // The report holds only what it prints. The first version of it reached a
    // profile's governed rows, and a row carries its whole event — invisible
    // on screen, and present in anything that serialised the structure.
    const marked = minimalEvent("018f1b70-2c18-7f3a-b46d-000000000090", {
      resource: { type: "configuration", id: "distinctive-marker-value" },
      metadata: { note: "another-marker" },
    });
    const report = await buildArchiveReport([loaded("r1", marked)], summary, undefined);
    const rendered = JSON.stringify(report);

    expect(rendered).not.toContain("distinctive-marker-value");
    expect(rendered).not.toContain("another-marker");
    expect(rendered).not.toContain("018f1b70-2c18-7f3a-b46d-000000000090");
  });
});

describe("the release metadata", () => {
  // The release workflow refuses a tag that disagrees with these, and the
  // table below is the one a reader consults to learn whether their version
  // still receives fixes. It went two releases without moving; nothing
  // checked it.
  it("states one current release, and it is this build's minor", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    const security = readFileSync(new URL("../../../SECURITY.md", import.meta.url), "utf8");
    const minor = manifest.version.split(".").slice(0, 2).join(".");

    const current = [...security.matchAll(/^\| ([0-9]+\.[0-9]+)\.x\s*\| Current release/gm)].map(
      (match) => match[1],
    );
    expect(current).toEqual([minor]);
  });

  it("carries the same version in every file the release guard compares", () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    const manifest = JSON.parse(read("../../../package.json")) as { version: string };
    const tauri = JSON.parse(read("../../../src-tauri/tauri.conf.json")) as { version: string };
    const crate = /^version = "([^"]+)"/m.exec(read("../../../src-tauri/Cargo.toml"))?.[1];
    const locked = /name = "openaudit-viewer"\nversion = "([^"]+)"/.exec(
      read("../../../src-tauri/Cargo.lock"),
    )?.[1];

    expect(tauri.version).toBe(manifest.version);
    expect(crate).toBe(manifest.version);
    expect(locked).toBe(manifest.version);
  });

  it("has a dated changelog section for this version", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    const changelog = readFileSync(new URL("../../../CHANGELOG.md", import.meta.url), "utf8");
    expect(changelog).toMatch(
      new RegExp(`^## ${manifest.version.replace(/\./g, "\\.")} - \\d{4}-\\d{2}-\\d{2}$`, "m"),
    );
  });
});

describe("where to start", () => {
  function row(
    id: string,
    file: string,
    application: string,
    eventName: string,
    valid: boolean,
    findings: number,
  ): LoadedEvent {
    return {
      rowId: id,
      sourceFile: file,
      sourceFormat: "jsonl",
      event: valid ? minimalEvent(id) : null,
      valid,
      errors: [],
      eventName,
      applicationName: application,
      privacyFindings: Array.from({ length: findings }, () => ({
        ruleId: "OAM-PRIV-001",
        severity: "high",
        confidence: "high",
        category: "credential",
        path: "/metadata/token",
        message: "looks like a credential",
      })) as LoadedEvent["privacyFindings"],
    };
  }

  it("says there is nowhere to start when nothing was found", () => {
    const clean = triage([row("a", "a.jsonl", "app", "x.y.z", true, 0)]);
    expect(clean.clean).toBe(true);
    expect(clean.files).toEqual([]);
    expect(clean.names).toEqual([]);
    expect(clean.applications).toEqual([]);
  });

  it("ranks by how much there is to fix, before anything else", () => {
    const many = Array.from({ length: 8 }, (_, n) =>
      row(`m${n}`, "many.jsonl", "app", "x.y.z", false, 0),
    );
    const few = [0, 1, 2].map((n) => row(`f${n}`, "few.jsonl", "app", "x.y.z", false, 0));

    // Eight invalid events are more work than three, however they are spread.
    expect(triage([...few, ...many]).files.map((entry) => entry.key)).toEqual([
      "many.jsonl",
      "few.jsonl",
    ]);
  });

  it("breaks an equal count by concentration, not by size", () => {
    // Three invalid of three is a file that is wholly wrong, and probably
    // wrong for one reason. Three of nine hundred is three accidents. The
    // concentrated one is the better place to start.
    const small = [0, 1, 2].map((n) => row(`s${n}`, "small.jsonl", "app", "x.y.z", false, 0));
    const large = [
      ...[0, 1, 2].map((n) => row(`l${n}`, "large.jsonl", "app", "x.y.z", false, 0)),
      ...Array.from({ length: 900 }, (_, n) =>
        row(`v${n}`, "large.jsonl", "app", "x.y.z", true, 0),
      ),
    ];

    const ranked = triage([...small, ...large]).files;
    expect(ranked.map((entry) => entry.key)).toEqual(["small.jsonl", "large.jsonl"]);
    expect(ranked[0]).toMatchObject({ invalid: 3, events: 3 });
    expect(ranked[1]).toMatchObject({ invalid: 3, events: 903 });
  });

  it("groups privacy findings by event name, counting events and findings separately", () => {
    const rows = [
      row("a", "a.jsonl", "app", "identity.role.assign", true, 3),
      row("b", "a.jsonl", "app", "identity.role.assign", true, 1),
      row("c", "a.jsonl", "app", "document.share.create", true, 2),
      row("d", "a.jsonl", "app", "document.share.create", true, 0),
    ];
    const names = triage(rows).names;

    expect(names[0]).toMatchObject({
      key: "identity.role.assign",
      findings: 4,
      flagged: 2,
      events: 2,
    });
    expect(names[1]).toMatchObject({ key: "document.share.create", findings: 2, flagged: 1 });
  });

  it("lists nothing it was not given: no rule of its own, no judgement", () => {
    // Every count is a regrouping of what the engines reported. A row with no
    // finding and a valid schema appears nowhere, whatever it contains.
    const rows = [
      row("a", "a.jsonl", "app", "x.y.z", true, 0),
      row("b", "b.jsonl", "other", "x.y.z", true, 0),
    ];
    const result = triage(rows);
    expect(result.clean).toBe(true);
  });

  it("offers at most five of each kind, taking the worst", () => {
    const rows = Array.from({ length: 9 }, (_, n) =>
      // n invalid events in file n, so the ranking is unambiguous.
      Array.from({ length: n + 1 }, (_, k) =>
        row(`r${n}-${k}`, `f${n}.jsonl`, "app", "x.y.z", false, 0),
      ),
    ).flat();

    const files = triage(rows).files;
    expect(files).toHaveLength(5);
    expect(files.map((entry) => entry.key)).toEqual([
      "f8.jsonl",
      "f7.jsonl",
      "f6.jsonl",
      "f5.jsonl",
      "f4.jsonl",
    ]);
  });

  it("is stable: the same archive produces the same order", () => {
    const rows = ["a", "b", "c"].map((key) => row(key, `${key}.jsonl`, "app", "x.y.z", false, 0));
    const first = triage(rows).files.map((entry) => entry.key);
    const second = triage([...rows].reverse()).files.map((entry) => entry.key);
    expect(first).toEqual(second);
  });
});
