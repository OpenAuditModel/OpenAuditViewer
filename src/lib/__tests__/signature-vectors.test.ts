/**
 * The signature vectors, from the frontend's side.
 *
 * `src-tauri/tests/signature_vectors.rs` holds the Rust verifier to the
 * answers recorded in `signature-vectors.json`. This file makes sure those
 * answers are still the CLI's: it asks the pinned `@openauditmodel/cli` again
 * for every vector, so moving the pin cannot leave the Rust suite checking
 * against a verdict the reference implementation no longer gives. It also
 * checks that the bytes each vector says were signed are the bytes this app
 * computes and sends to Rust — the other half of parity, and the half the Rust
 * suite cannot see.
 */
import {
  constants,
  createPublicKey,
  generateKeyPairSync,
  sign as nodeSign,
  verify as nodeVerify,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalBytes as referenceCanonicalBytes } from "@openauditmodel/cli/conformance/integrity/canonicalize.js";
import { buildDigestInput as referenceDigestInput } from "@openauditmodel/cli/conformance/integrity/digest.js";
import { verifyEventSignature } from "@openauditmodel/cli/conformance/integrity/signature.js";
import { canonicalBytes } from "../integrity/canonicalize";
import { buildDigestInput } from "../integrity/digest";
import { verifyEventIntegrity } from "../integrity/verify-event";
import { verifyChains } from "../integrity/chain";
import {
  formatFingerprint,
  toBase64,
  type KeySummary,
  type SignatureCheck,
  type SignatureVerifier,
} from "../integrity/trusted-key";

interface Answer {
  readonly ok: boolean;
  readonly kind?: string;
  readonly message?: string;
}

interface Vector {
  readonly name: string;
  readonly algorithm: string;
  readonly value: string;
  readonly publicKeyPem: string;
  readonly event: unknown;
  readonly messageBase64: string;
  readonly cli: Answer;
  readonly divergence?: string;
  readonly viewer?: Answer;
}

const vectorsPath = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "src-tauri",
  "tests",
  "signature-vectors.json",
);
const { vectors } = JSON.parse(readFileSync(vectorsPath, "utf8")) as {
  readonly vectors: readonly Vector[];
};

function examples(relative: string): string {
  return readFileSync(
    join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "node_modules",
      "@openauditmodel",
      "cli",
      "examples",
      relative,
    ),
    "utf8",
  );
}

describe("signature vectors", () => {
  it("still covers every case it was written with", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(35);
  });

  it.each(vectors.map((vector) => [vector.name, vector] as const))(
    "%s: the CLI still gives the answer the vector records",
    (_name, vector) => {
      const result = verifyEventSignature(
        vector.event,
        vector.algorithm,
        vector.value,
        createPublicKey(vector.publicKeyPem),
      );
      const answer = result.ok
        ? { ok: true }
        : { ok: false, kind: result.kind, message: result.message };
      expect(answer).toEqual(vector.cli);
    },
  );

  it.each(vectors.map((vector) => [vector.name, vector] as const))(
    "%s: the signed bytes are the ones this app computes",
    (_name, vector) => {
      const expected = Buffer.from(vector.messageBase64, "base64");
      const reference = Buffer.from(referenceCanonicalBytes(referenceDigestInput(vector.event)));
      const ours = Buffer.from(canonicalBytes(buildDigestInput(vector.event)));
      expect(reference.equals(expected)).toBe(true);
      expect(ours.equals(expected)).toBe(true);
      expect(toBase64(canonicalBytes(buildDigestInput(vector.event)))).toBe(vector.messageBase64);
    },
  );

  it("names a reason for every answer that differs from the CLI's, and only refuses", () => {
    for (const vector of vectors) {
      expect(vector.divergence === undefined, vector.name).toBe(vector.viewer === undefined);
      if (vector.viewer !== undefined) {
        expect(vector.cli.ok && !vector.viewer.ok, vector.name).toBe(true);
        expect((vector.divergence ?? "").length, vector.name).toBeGreaterThan(40);
      }
    }
  });
});

/**
 * A verifier that answers as the CLI does, standing in for the Rust side, so
 * that what is tested here is what the engines do with an answer.
 */
function referenceVerifier(pem: string, calls: Uint8Array[] = []): SignatureVerifier {
  const key: KeySummary = {
    keyType: "test",
    fingerprint: "0".repeat(64),
    fileName: "test.pem",
    usableFor: [],
  };
  return {
    key,
    async verify(algorithm, value, message): Promise<SignatureCheck> {
      calls.push(message);
      const publicKey = createPublicKey(pem);
      const signature = Buffer.from(value, "base64");
      let ok: boolean;
      if (algorithm === "Ed25519") {
        ok = nodeVerify(null, message, publicKey, signature);
      } else if (algorithm === "ECDSA-P256-SHA256") {
        ok = nodeVerify(
          "sha256",
          message,
          { key: publicKey, dsaEncoding: "ieee-p1363" },
          signature,
        );
      } else {
        ok = nodeVerify(
          "sha256",
          message,
          {
            key: publicKey,
            padding: constants.RSA_PKCS1_PSS_PADDING,
            saltLength: constants.RSA_PSS_SALTLEN_AUTO,
          },
          signature,
        );
      }
      return ok
        ? { ok: true }
        : { ok: false, kind: "signature-invalid", message: "signature does not match" };
    },
  };
}

describe("what the engines do with a key", () => {
  const fixtures = [
    ["signed-event-ed25519.json", "ed25519-test-public.pem", "Ed25519"],
    ["signed-event-ecdsa-p256.json", "ecdsa-p256-test-public.pem", "ECDSA-P256-SHA256"],
    ["signed-event-rsa-pss.json", "rsa-pss-test-public.pem", "RSA-PSS-SHA256"],
  ] as const;

  it.each(fixtures)("%s verifies against its key and says so", async (file, keyFile, algorithm) => {
    const event = JSON.parse(examples(`integrity/valid/${file}`)) as unknown;
    const calls: Uint8Array[] = [];
    const result = await verifyEventIntegrity(event, file, {
      signatureVerifier: referenceVerifier(examples(`integrity/keys/${keyFile}`), calls),
    });
    expect(result.verified).toBe(true);
    expect(result.checks.map((check) => check.message)).toContain(`signature valid (${algorithm})`);
    // What was sent for checking is what the signer signed.
    expect(calls).toHaveLength(1);
    expect(
      Buffer.from(calls[0] as Uint8Array).equals(
        Buffer.from(referenceCanonicalBytes(referenceDigestInput(event))),
      ),
    ).toBe(true);
  });

  it("without a key, a declared signature is reported and not checked", async () => {
    const event = JSON.parse(examples("integrity/valid/signed-event-ed25519.json")) as unknown;
    const result = await verifyEventIntegrity(event, "event");
    expect(result.verified).toBe(true);
    expect(result.checks.map((check) => check.message)).toContain(
      "signature declared (Ed25519), not checked: no public key was chosen",
    );
  });

  it("the wrong key fails the event with the verifier's finding", async () => {
    const event = JSON.parse(examples("integrity/valid/signed-event-ed25519.json")) as unknown;
    const pem = createPublicKey(examples("integrity/keys/ecdsa-p256-test-public.pem"));
    const wrong: SignatureVerifier = {
      key: referenceVerifier("").key,
      verify: async () => ({
        ok: false,
        kind: "signature-invalid",
        message: `the supplied public key is ${pem.asymmetricKeyType ?? "?"}, but Ed25519 needs ed25519`,
      }),
    };
    const result = await verifyEventIntegrity(event, "event", { signatureVerifier: wrong });
    expect(result.verified).toBe(false);
    expect(result.findings).toEqual([
      {
        kind: "signature-invalid",
        label: "event",
        message: "the supplied public key is ec, but Ed25519 needs ed25519",
      },
    ]);
  });

  it("a verifier that cannot answer never leaves the event looking verified", async () => {
    const event = JSON.parse(examples("integrity/valid/signed-event-ed25519.json")) as unknown;
    const failing: SignatureVerifier = {
      key: referenceVerifier("").key,
      verify: () => Promise.reject(new Error("the trusted key changed")),
    };
    const result = await verifyEventIntegrity(event, "event", { signatureVerifier: failing });
    expect(result.verified).toBe(false);
    expect(result.findings[0]?.message).toMatch(/could not be checked/);
  });

  it("an event with no signature is not sent for checking", async () => {
    const event = JSON.parse(examples("integrity/valid/single-event-sha256.json")) as unknown;
    const calls: Uint8Array[] = [];
    const result = await verifyEventIntegrity(event, "event", {
      signatureVerifier: referenceVerifier(
        examples("integrity/keys/ed25519-test-public.pem"),
        calls,
      ),
    });
    expect(result.verified).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("chain verification checks each member's signature with the key", async () => {
    // No published chain is signed, so this one is: the signature is outside
    // the digest input, so adding it leaves every hash and link as it was.
    const signer = generateKeyPairSync("ed25519");
    const publicPem = signer.publicKey.export({ type: "spki", format: "pem" }).toString();
    const members = ["001.json", "002.json", "003.json"].map((name) => {
      const event = JSON.parse(examples(`integrity/valid/three-event-chain/${name}`)) as Record<
        string,
        unknown
      >;
      const value = nodeSign(
        null,
        referenceCanonicalBytes(referenceDigestInput(event)),
        signer.privateKey,
      ).toString("base64");
      (event["integrity"] as Record<string, unknown>)["signature"] = {
        algorithm: "Ed25519",
        value,
      };
      return { label: name, event };
    });

    const calls: Uint8Array[] = [];
    const report = await verifyChains(members, {
      signatureVerifier: referenceVerifier(publicPem, calls),
    });
    expect(report.intact).toBe(true);
    expect(calls).toHaveLength(3);

    const refusing: SignatureVerifier = {
      key: referenceVerifier("").key,
      verify: async () => ({
        ok: false,
        kind: "signature-invalid",
        message: "signature does not match",
      }),
    };
    const broken = await verifyChains(members, { signatureVerifier: refusing });
    expect(broken.intact).toBe(false);
    expect(
      broken.chains
        .flatMap((chain) => chain.findings)
        .filter((f) => f.kind === "signature-invalid"),
    ).toHaveLength(3);

    // And without a key the same chain is intact, its signatures reported unchecked.
    expect((await verifyChains(members)).intact).toBe(true);
  });
});

describe("the key's presentation", () => {
  it("encodes bytes as Node does, across the chunk boundary", () => {
    const bytes = new Uint8Array(0x8000 * 2 + 7).map((_, index) => (index * 31) & 0xff);
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString("base64"));
    expect(toBase64(new Uint8Array())).toBe("");
  });

  it("groups a fingerprint for reading aloud", () => {
    expect(formatFingerprint("0123456789abcdef")).toBe("0123 4567 89ab cdef");
  });
});
