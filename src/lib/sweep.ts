/**
 * The Overview's digest sweep: every declared digest in a folder, verified one
 * after another, under one key or none.
 *
 * Kept out of the component so the one property that matters can be tested
 * without a window: a sweep whose folder or key changed while it ran returns
 * nothing at all. Checking only before each event is not enough — the last
 * event's verdict arrives after the last check, and a key chosen in that
 * moment would find the previous key's verdicts painted beside its own
 * fingerprint.
 */
import { verifyEventIntegrity } from "./integrity/verify-event";
import type { SignatureVerifier } from "./integrity/trusted-key";
import type { LoadedEvent } from "./types";

export interface SweepResult {
  readonly verified: number;
  readonly failed: readonly { readonly label: string; readonly message: string }[];
}

/**
 * Verifies each row's digest, and its signature when `verifier` is given.
 * `stillCurrent` is asked before every event and once more after the last;
 * the first time it answers false, the sweep stops and returns `undefined`.
 */
export async function sweepDigests(
  rows: readonly LoadedEvent[],
  verifier: SignatureVerifier | undefined,
  stillCurrent: () => boolean,
): Promise<SweepResult | undefined> {
  let verified = 0;
  const failed: { label: string; message: string }[] = [];

  for (const row of rows) {
    if (!stillCurrent()) {
      return undefined;
    }
    const result = await verifyEventIntegrity(row.event, row.sourceFile, {
      validateSchema: false,
      ...(verifier === undefined ? {} : { signatureVerifier: verifier }),
    });
    if (result.verified) {
      verified += 1;
    } else {
      failed.push({
        label: row.rowId,
        message: result.findings.map((finding) => finding.message).join("; "),
      });
    }
  }

  return stillCurrent() ? { verified, failed } : undefined;
}
