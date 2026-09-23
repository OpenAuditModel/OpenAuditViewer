/**
 * The digest sweep drops its answer when the folder or the key changes under
 * it — including while its last event is in flight, which is the moment the
 * pre-release review found unguarded.
 */
import { describe, expect, it } from "vitest";
import { sweepDigests } from "../sweep";
import { calculateDigest } from "../integrity/digest";
import type { SignatureVerifier } from "../integrity/trusted-key";
import type { LoadedEvent } from "../types";

async function signedRow(id: number): Promise<LoadedEvent> {
  const event: Record<string, unknown> = {
    specVersion: "0.1",
    id: `018f1b70-2c18-7f3a-b46d-${String(id).padStart(12, "0")}`,
    time: "2026-09-23T10:00:00.000Z",
    event: { name: "data.record.update", category: "data-modification", outcome: "success" },
    actor: { type: "user", id: "user-1" },
    resource: { type: "record", id: `record-${id}` },
    application: { name: "sweep-test", environment: "test" },
    integrity: { canonicalization: "RFC8785", hashAlgorithm: "SHA-256", hash: "" },
  };
  (event["integrity"] as Record<string, unknown>)["hash"] = await calculateDigest(event, "SHA-256");
  // Outside the digest input, so the hash still holds.
  (event["integrity"] as Record<string, unknown>)["signature"] = {
    algorithm: "Ed25519",
    value: `${"A".repeat(86)}==`,
  };
  return {
    rowId: `row-${id}`,
    sourceFile: "a.jsonl",
    sourceFormat: "jsonl",
    event,
    valid: true,
    errors: [],
    privacyFindings: [],
    eventName: "data.record.update",
  };
}

/** A verifier whose answers wait until `release` is called. */
function heldVerifier(): { verifier: SignatureVerifier; release: () => void; calls: () => number } {
  let waiting: (() => void)[] = [];
  let count = 0;
  return {
    verifier: {
      key: {
        keyType: "ed25519",
        fingerprint: "a".repeat(64),
        fileName: "a.pem",
        usableFor: ["Ed25519"],
      },
      verify: () => {
        count += 1;
        return new Promise((resolve) => waiting.push(() => resolve({ ok: true })));
      },
    },
    release: () => {
      const now = waiting;
      waiting = [];
      now.forEach((resolve) => resolve());
    },
    calls: () => count,
  };
}

/** Waits until `condition` holds; hashing runs through Web Crypto, off the microtask queue. */
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("condition never held");
}

describe("the digest sweep", () => {
  it("answers when nothing changed", async () => {
    const rows = [await signedRow(1), await signedRow(2)];
    const held = heldVerifier();
    const running = sweepDigests(rows, held.verifier, () => true);
    for (let index = 1; index <= rows.length; index += 1) {
      await until(() => held.calls() === index);
      held.release();
    }
    expect(await running).toEqual({ verified: 2, failed: [] });
  });

  it("drops its answer when the key changes while the last event is being verified", async () => {
    const rows = [await signedRow(1), await signedRow(2)];
    const held = heldVerifier();
    let current = true;
    const running = sweepDigests(rows, held.verifier, () => current);

    await until(() => held.calls() === 1);
    held.release();
    await until(() => held.calls() === 2);
    // The last verdict is in flight; the user chooses another key now.
    current = false;
    held.release();

    expect(await running).toBeUndefined();
  });

  it("stops before the next event when the folder changes", async () => {
    const rows = [await signedRow(1), await signedRow(2), await signedRow(3)];
    const held = heldVerifier();
    let current = true;
    const running = sweepDigests(rows, held.verifier, () => current);

    await until(() => held.calls() === 1);
    current = false;
    held.release();

    expect(await running).toBeUndefined();
    expect(held.calls()).toBe(1);
  });
});
