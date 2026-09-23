/**
 * The public key a user chose to verify signatures with, and the one way the
 * engines reach it.
 *
 * Verification itself runs in Rust (src-tauri/src/signature.rs): Web Crypto
 * cannot recover an RSA-PSS salt length the way the reference verifier does,
 * and its Ed25519 support depends on which webview runtime a machine has. The
 * key file is chosen in a native dialog that Rust opens and is read and held
 * there; this side never sees a path or the key's bytes, only a summary.
 *
 * The engines take a {@link SignatureVerifier} as an option rather than
 * reaching for app state, so that every verdict names the key it was reached
 * under, and so that the engines stay testable without a Tauri host.
 */
import { invoke } from "@tauri-apps/api/core";
import type { EventFindingKind } from "./types";

/** What the app is told about the trusted key. Never the key itself. */
export interface KeySummary {
  /** The key type as the CLI names it: `ed25519`, `ec`, `rsa`, `rsa-pss`, … */
  readonly keyType: string;
  readonly curve?: string;
  readonly modulusBits?: number;
  /**
   * SHA-256 of the key's SubjectPublicKeyInfo DER, lowercase hex: what
   * `grep -v -- ----- key.pem | base64 -d | shasum -a 256` prints. Not
   * `openssl pkey`: macOS ships LibreSSL, which cannot read an Ed25519 key,
   * prints nothing, and leaves `shasum` to print the digest of nothing.
   */
  readonly fingerprint: string;
  readonly fileName: string;
  /** The signature algorithms this key can verify, in the CLI's names. */
  readonly usableFor: readonly string[];
}

/** One signature's answer, in the shape the CLI's `SignatureCheckResult` has. */
export type SignatureCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly kind: EventFindingKind; readonly message: string };

/** Checks declared signatures against one key. */
export interface SignatureVerifier {
  readonly key: KeySummary;
  /** `message` is the canonical digest input: what the signer signed. */
  verify(algorithm: string, value: string, message: Uint8Array): Promise<SignatureCheck>;
}

/** Opens the native dialog. `undefined` when the user cancelled. */
export async function chooseTrustedKey(): Promise<KeySummary | undefined> {
  const summary = await invoke<KeySummary | null>("choose_public_key");
  return summary ?? undefined;
}

export async function forgetTrustedKey(): Promise<void> {
  await invoke("forget_public_key");
}

export async function currentTrustedKey(): Promise<KeySummary | undefined> {
  const summary = await invoke<KeySummary | null>("trusted_public_key");
  return summary ?? undefined;
}

/**
 * The verifier for a key Rust holds. Each call names the key's fingerprint, and
 * Rust refuses to answer under a different one — so a verdict started before
 * the user switched keys cannot come back labelled with the new key.
 */
export function trustedKeyVerifier(key: KeySummary): SignatureVerifier {
  return {
    key,
    async verify(algorithm, value, message) {
      const outcome = await invoke<{ ok: boolean; kind?: EventFindingKind; message?: string }>(
        "verify_signature",
        {
          fingerprint: key.fingerprint,
          algorithm,
          value,
          messageBase64: toBase64(message),
        },
      );
      if (outcome.ok) {
        return { ok: true };
      }
      return {
        ok: false,
        kind: outcome.kind ?? "signature-invalid",
        message: outcome.message ?? "signature does not match",
      };
    },
  };
}

/** Standard base64, padded. The bytes go to Rust as text because IPC is JSON. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK));
  }
  return btoa(binary);
}

/** The fingerprint as a person compares it: four-character groups. */
export function formatFingerprint(fingerprint: string): string {
  return fingerprint.match(/.{1,4}/g)?.join(" ") ?? fingerprint;
}
