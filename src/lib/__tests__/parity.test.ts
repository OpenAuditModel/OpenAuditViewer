/**
 * Parity with the published engines, over the published corpus.
 *
 * The analysis this app performs is `@openauditmodel/cli`'s, reached through
 * the seam in `src/lib/engines.ts`, which binds this app's precompiled
 * validator to it. Three things can still go wrong, and this suite is about
 * those three:
 *
 * 1. The seam binds the wrong validator or drops an option, and the app answers
 *    differently from the package it embeds. Every fixture the kit names is run
 *    through the bound engines and through the package's own, and the answers
 *    must be identical.
 * 2. The precompiled validator — generated at build time, the one piece of
 *    analysis that is neither ported nor shared — disagrees with the package's.
 * 3. Split provenance: engines from one release, the schema and profiles they
 *    evaluate from another. This used to be a comparison between vendored
 *    copies and the pinned release; the copies are gone and both halves are
 *    imported from the package, so the only thing left to assert is that the
 *    pin is exact.
 *
 * Both sides are computed here, so there is no stored expectation to rot. The
 * suite runs in Node under vitest: `node:fs` and the package's filesystem-bound
 * schema loader are fine here and reach no bundle.
 *
 * It was written against the forked engines before they were deleted, and it
 * found one divergence then — see the 0.4.0 changelog entry about a validation
 * issue's detail. That is what it is for.
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { readdirSync } from "node:fs";
import { verifyChains } from "../integrity/chain";
import { verifyEventIntegrity } from "../integrity/verify-event";
import { lintEvent as boundLintEvent } from "../engines";
import {
  ALL_PROFILES,
  REFUSED_PROFILES,
  SUPPORTED_PROFILE_VERSION,
  checkProfile as boundCheckProfile,
  partitionProfiles,
} from "../profiles";
import type { ProfileDefinition } from "@openauditmodel/cli/conformance/profiles/types.js";
import { validateEvent } from "../schema";
import canonicalSchema from "@openauditmodel/cli/schemas/v0.1/audit-event.schema.json";

import { lintEvent as publishedLintEvent } from "@openauditmodel/cli/conformance/privacy/lint-event.js";
import { checkProfile as publishedCheckProfile } from "@openauditmodel/cli/conformance/profiles/check-profile.js";
import { createValidator, resolveSchemaPath } from "@openauditmodel/cli/conformance/validate.js";

const require_ = createRequire(import.meta.url);

/** The kit names every fixture; the package ships both, at one version. */
const manifestPath = require_.resolve("@openauditmodel/cli/conformance-kit/manifest.json");
const packageRoot = path.dirname(path.dirname(manifestPath));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
  readonly fixtures: readonly {
    readonly fixture: string;
    readonly verifyIntegrity?: { readonly verified: boolean; readonly findings: readonly string[] };
  }[];
  readonly chains: readonly {
    readonly fixtures: string;
    readonly intact: boolean;
    readonly eventCount: number;
    readonly chains: readonly {
      readonly eventCount: number;
      readonly intact: boolean;
      readonly findings: readonly string[];
    }[];
  }[];
};

const corpus = manifest.fixtures.map((entry) => ({
  label: entry.fixture,
  event: JSON.parse(readFileSync(path.join(packageRoot, entry.fixture), "utf8")) as unknown,
}));

/** This app's precompiled validator, in the shape the published engines take. */
const validator = { schemaId: canonicalSchema.$id, validateEvent };

/** The published engines' own validator, compiled from the package's schema. */
const publishedValidator = createValidator(resolveSchemaPath());

/**
 * Compares two verdicts structurally. Both come from the same code shape, so a
 * key-order difference would itself be a divergence worth seeing.
 */
function differs(mine: unknown, theirs: unknown): boolean {
  return JSON.stringify(mine) !== JSON.stringify(theirs);
}

describe("the corpus this parity suite runs on", () => {
  test("is the published one, and every fixture the kit names is readable", () => {
    expect(corpus.length).toBe(manifest.fixtures.length);
    expect(corpus.length).toBeGreaterThan(300);
  });

  test("is the release the app itself imports, schema and profiles alike", () => {
    // Split provenance — engines from one release, the documents they evaluate
    // from another — used to be prevented by comparing vendored copies against
    // the package. There are no copies now: both are imported from it, so this
    // reads the same files back from disk and asserts the app is holding what
    // the package ships rather than something bundled from elsewhere.
    const packageSchema = JSON.parse(
      readFileSync(path.join(packageRoot, "schemas", "v0.1", "audit-event.schema.json"), "utf8"),
    ) as { $id: string };
    expect(canonicalSchema).toEqual(packageSchema);

    for (const profile of ALL_PROFILES) {
      const published = JSON.parse(
        readFileSync(path.join(packageRoot, "profiles", profile.name, "profile.json"), "utf8"),
      ) as unknown;
      expect({ [profile.name]: profile }).toEqual({ [profile.name]: published });
    }
    expect(ALL_PROFILES.length + REFUSED_PROFILES.length).toBe(
      readdirSync(path.join(packageRoot, "profiles"), { withFileTypes: true }).filter(
        (entry) =>
          entry.isDirectory() &&
          existsSync(path.join(packageRoot, "profiles", entry.name, "profile.json")),
      ).length,
    );
  });

  test("is pinned to an exact version, not a range", () => {
    const manifestJson = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf8"),
    ) as { readonly dependencies: Record<string, string> };
    expect(manifestJson.dependencies["@openauditmodel/cli"]).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("privacy linting", () => {
  test("the bound engine answers exactly what the published one answers, for every fixture", () => {
    const mismatched: string[] = [];
    let first: { mine: unknown; theirs: unknown } | undefined;

    for (const { label, event } of corpus) {
      const mine = boundLintEvent(event, label);
      const theirs = publishedLintEvent(event, label, validator);
      if (differs(mine, theirs)) {
        mismatched.push(label);
        first ??= { mine, theirs };
      }
    }

    if (first !== undefined) {
      expect(first.mine).toEqual(first.theirs);
    }
    expect(mismatched).toEqual([]);
  });
});

describe("profile conformance", () => {
  test("the bound engine answers exactly what the published one answers, for every fixture and profile", () => {
    const mismatched: string[] = [];
    let first: { mine: unknown; theirs: unknown } | undefined;

    for (const profile of ALL_PROFILES) {
      for (const { label, event } of corpus) {
        const mine = boundCheckProfile(event, label, profile);
        const theirs = publishedCheckProfile(event, label, profile, validator);
        if (differs(mine, theirs)) {
          mismatched.push(`${profile.name} :: ${label}`);
          first ??= { mine, theirs };
        }
      }
    }

    if (first !== undefined) {
      expect(first.mine).toEqual(first.theirs);
    }
    expect(mismatched).toEqual([]);
  });
});

describe("schema validation", () => {
  test("the precompiled validator agrees with the published one, for every fixture", () => {
    // The validator is generated at build time from the package's schema, so
    // it is the one piece of analysis that is neither ported nor shared. If it
    // disagreed, every verdict above would be comparing two engines that were
    // handed different facts.
    const mismatched: string[] = [];
    let first: { mine: unknown; theirs: unknown } | undefined;

    for (const { label, event } of corpus) {
      const mine = validateEvent(event);
      const theirs = publishedValidator.validateEvent(event);
      if (differs(mine, theirs)) {
        mismatched.push(label);
        first ??= { mine, theirs };
      }
    }

    if (first !== undefined) {
      expect(first.mine).toEqual(first.theirs);
    }
    expect(mismatched).toEqual([]);
  });
});

describe("the profile version gate", () => {
  test("implements the version the pinned package's definition schema declares", () => {
    // Hard-coding the version this build implements is only safe while something
    // compares it to what the engines were written against.
    const schema = JSON.parse(
      readFileSync(path.join(packageRoot, "profiles", "profile-definition.schema.json"), "utf8"),
    ) as { readonly properties: { readonly profileVersion: { readonly const: string } } };

    expect(SUPPORTED_PROFILE_VERSION).toBe(schema.properties.profileVersion.const);
  });

  test("refuses a profile written in a vocabulary this build does not implement", () => {
    const [known] = ALL_PROFILES;
    expect(known).toBeDefined();

    const future = {
      ...(known as ProfileDefinition),
      profileVersion: "0.2",
      name: "from-the-future",
    };
    const { supported, refused } = partitionProfiles([known as ProfileDefinition, future]);

    expect(supported.map((profile) => profile.name)).toEqual([(known as ProfileDefinition).name]);
    expect(refused).toEqual([{ name: "from-the-future", profileVersion: "0.2" }]);
  });

  test("evaluates every profile the package publishes, and refuses none of them", () => {
    expect(REFUSED_PROFILES).toEqual([]);
    expect(ALL_PROFILES.length).toBe(10);
    for (const profile of ALL_PROFILES) {
      expect(profile.profileVersion, profile.name).toBe(SUPPORTED_PROFILE_VERSION);
    }
  });
});

/** Every `.json` file under a directory, recursively, in the order the kit generator uses. */
function jsonFilesUnder(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name, "en"),
  )) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...jsonFilesUnder(full));
    } else if (entry.name.endsWith(".json")) {
      found.push(full);
    }
  }
  return found;
}

describe("integrity — the one engine still carried here", () => {
  // Digest and chain verification are not imported from the package: Web Crypto
  // is asynchronous where Node's hashing is not, so this app keeps its own port.
  // A port can drift, and the differential suite above cannot see it. The kit
  // manifest records what the reference implementation answers for every
  // fixture with integrity material and for every published chain directory,
  // computed by the same engines the CLI runs — the one place where a stored
  // expectation is the right tool, because the code it checks is deliberately
  // not shared. Compared as the kit records it: the verdict and the finding
  // kinds, never the wording.

  test("every fixture with integrity material verifies as the kit records", async () => {
    const recorded = manifest.fixtures.filter((entry) => entry.verifyIntegrity !== undefined);
    expect(recorded.length).toBeGreaterThan(0);

    const mismatched: string[] = [];
    let first: { mine: unknown; theirs: unknown } | undefined;

    for (const entry of recorded) {
      const event = JSON.parse(
        readFileSync(path.join(packageRoot, entry.fixture), "utf8"),
      ) as unknown;
      const result = await verifyEventIntegrity(event, entry.fixture);
      const mine = { verified: result.verified, findings: result.findings.map((f) => f.kind) };
      const theirs = entry.verifyIntegrity;
      if (differs(mine, theirs)) {
        mismatched.push(entry.fixture);
        first ??= { mine, theirs };
      }
    }

    if (first !== undefined) {
      expect(first.mine).toEqual(first.theirs);
    }
    expect(mismatched).toEqual([]);
  });

  test("every published chain directory verifies as the kit records", async () => {
    expect(manifest.chains.length).toBeGreaterThan(0);

    const mismatched: string[] = [];
    let first: { mine: unknown; theirs: unknown } | undefined;

    for (const record of manifest.chains) {
      const inputs = jsonFilesUnder(path.join(packageRoot, record.fixtures)).map((file) => ({
        label: path.relative(packageRoot, file),
        event: JSON.parse(readFileSync(file, "utf8")) as unknown,
      }));
      const report = await verifyChains(inputs);
      const mine = {
        intact: report.intact,
        eventCount: report.eventCount,
        chains: report.chains.map((chain) => ({
          eventCount: chain.eventCount,
          intact: chain.intact,
          findings: chain.findings.map((f) => f.kind),
        })),
      };
      const theirs = {
        intact: record.intact,
        eventCount: record.eventCount,
        chains: record.chains,
      };
      if (differs(mine, theirs)) {
        mismatched.push(record.fixtures);
        first ??= { mine, theirs };
      }
    }

    if (first !== undefined) {
      expect(first.mine).toEqual(first.theirs);
    }
    expect(mismatched).toEqual([]);
  });
});
