/**
 * Writes the signature test vectors the Rust verifier is held to.
 *
 * Signature verification runs in Rust (src-tauri/src/signature.rs), not in the
 * webview, and the canonical verifier runs in Node on OpenSSL. Parity between
 * the two cannot be asserted by running them side by side, because no test
 * process holds both. So the CLI's answers are recorded here instead: every
 * vector carries the exact bytes that were signed, the key, the value, and
 * what `@openauditmodel/cli`'s own `verifyEventSignature` says about them.
 * `cargo test` holds the Rust side to those answers, and
 * `src/lib/__tests__/signature-vectors.test.ts` re-asks the package on every
 * run, so a vector cannot keep an answer the CLI no longer gives.
 *
 * Keys are generated fresh each time this runs, so the output is not
 * reproducible byte for byte and is not meant to be: it is written once,
 * committed, and checked by asking the package again rather than by
 * regenerating and diffing. Rerun it only to add a case.
 *
 * Where the viewer deliberately answers differently from the CLI, the vector
 * says so in `divergence`, and the check refuses a difference without one.
 *
 *   node tools/generate-signature-vectors.mjs
 */
import {
  constants,
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  generatePrimeSync,
  sign,
} from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { canonicalBytes } from "@openauditmodel/cli/conformance/integrity/canonicalize.js";
import { buildDigestInput } from "@openauditmodel/cli/conformance/integrity/digest.js";
import { verifyEventSignature } from "@openauditmodel/cli/conformance/integrity/signature.js";

const viewerRoot = join(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const outputPath = join(viewerRoot, "src-tauri", "tests", "signature-vectors.json");

function packageFile(relative) {
  return readFileSync(require.resolve(`@openauditmodel/cli/examples/${relative}`), "utf8");
}

const fixtureKeys = {
  ed25519: packageFile("integrity/keys/ed25519-test-public.pem"),
  ecdsa: packageFile("integrity/keys/ecdsa-p256-test-public.pem"),
  rsaPss: packageFile("integrity/keys/rsa-pss-test-public.pem"),
};

function fixtureEvent(name) {
  return JSON.parse(packageFile(`integrity/${name}`));
}

/** The event every generated case signs. Its own signature is excluded from what is signed. */
const baseEvent = fixtureEvent("valid/signed-event-ed25519.json");

function message(event) {
  return canonicalBytes(buildDigestInput(event));
}

function publicPem(keyObject) {
  return keyObject.export({ type: "spki", format: "pem" });
}

const ED25519_ORDER = (1n << 252n) + 27742317777372353535851937790883648493n;
const P256_ORDER = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;

function toBigInt(bytes) {
  return BigInt(`0x${Buffer.from(bytes).toString("hex") || "0"}`);
}

function fromBigInt(value, length, littleEndian = false) {
  const hex = value.toString(16).padStart(length * 2, "0");
  const bytes = Buffer.from(hex, "hex");
  return littleEndian ? Buffer.from(bytes.reverse()) : bytes;
}

const vectors = [];

function add(name, { event = baseEvent, algorithm, value, publicKeyPem, divergence, viewer }) {
  const key = createPublicKey(publicKeyPem);
  const cli = verifyEventSignature(event, algorithm, value, key);
  vectors.push({
    name,
    algorithm,
    value,
    publicKeyPem,
    event,
    messageBase64: Buffer.from(message(event)).toString("base64"),
    cli: cli.ok ? { ok: true } : { ok: false, kind: cli.kind, message: cli.message },
    ...(divergence === undefined ? {} : { divergence, viewer }),
  });
}

// --- The published fixtures, exactly as shipped ------------------------------

for (const [file, key] of [
  ["valid/signed-event-ed25519.json", fixtureKeys.ed25519],
  ["valid/signed-event-ecdsa-p256.json", fixtureKeys.ecdsa],
  ["valid/signed-event-rsa-pss.json", fixtureKeys.rsaPss],
  ["invalid/tampered-signed-event.json", fixtureKeys.ed25519],
]) {
  const event = fixtureEvent(file);
  const { algorithm, value } = event.integrity.signature;
  add(`fixture ${file}`, { event, algorithm, value, publicKeyPem: key });
}

// --- Ed25519 ------------------------------------------------------------------

// A key whose signature spells differently in base64 and base64url, so that
// the base64url case below is a different string rather than, by chance, the
// same one.
let ed;
let edSignature;
do {
  ed = generateKeyPairSync("ed25519");
  edSignature = sign(null, message(baseEvent), ed.privateKey);
} while (!/[+/]/.test(edSignature.toString("base64")));
const edPem = publicPem(ed.publicKey);
const edBase64 = edSignature.toString("base64");

add("ed25519 valid", {
  algorithm: "Ed25519",
  value: edSignature.toString("base64"),
  publicKeyPem: edPem,
});
add("ed25519 signed by another key", {
  algorithm: "Ed25519",
  value: edSignature.toString("base64"),
  publicKeyPem: fixtureKeys.ed25519,
});
add("ed25519 value that is not base64", {
  algorithm: "Ed25519",
  value: "not*base64",
  publicKeyPem: edPem,
});
add("ed25519 base64url instead of base64", {
  algorithm: "Ed25519",
  value: edSignature.toString("base64url"),
  publicKeyPem: edPem,
});
// Node's base64 decoder is lenient, and the CLI's pattern admits any number of
// trailing "=" including none. What it accepts, the viewer must accept too.
add("ed25519 base64 without its padding", {
  algorithm: "Ed25519",
  value: edBase64.replace(/=+$/, ""),
  publicKeyPem: edPem,
});
add("ed25519 base64 with extra padding", {
  algorithm: "Ed25519",
  value: `${edBase64}=`,
  publicKeyPem: edPem,
});
{
  // The last data character of 64 bytes carries two bits of data and four
  // unused ones. Setting the unused bits changes the text, not the bytes.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const body = edBase64.replace(/=+$/, "");
  const last = alphabet.indexOf(body[body.length - 1]);
  const noisy = `${body.slice(0, -1)}${alphabet[last | 0x0f]}==`;
  add("ed25519 base64 with non-zero unused bits", {
    algorithm: "Ed25519",
    value: noisy,
    publicKeyPem: edPem,
  });
}
add("ed25519 base64 one character short of a byte", {
  algorithm: "Ed25519",
  value: edBase64.replace(/=+$/, "").slice(0, -1),
  publicKeyPem: edPem,
});
add("ed25519 one byte short", {
  algorithm: "Ed25519",
  value: edSignature.subarray(0, 63).toString("base64"),
  publicKeyPem: edPem,
});
{
  // S replaced by S + L: the same point equation, a non-canonical scalar.
  const s = toBigInt(Buffer.from(edSignature.subarray(32)).reverse());
  const malleated = Buffer.concat([
    edSignature.subarray(0, 32),
    fromBigInt(s + ED25519_ORDER, 32, true),
  ]);
  add("ed25519 non-canonical S (S + L)", {
    algorithm: "Ed25519",
    value: malleated.toString("base64"),
    publicKeyPem: edPem,
  });
}
{
  // The identity point as the key, with R = identity and S = 0. Cofactorless
  // verification without a small-order check accepts this for any message.
  const identity = Buffer.alloc(32);
  identity[0] = 1;
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), identity]);
  const pem = `-----BEGIN PUBLIC KEY-----\n${spki.toString("base64")}\n-----END PUBLIC KEY-----\n`;
  add("ed25519 small-order key and signature", {
    algorithm: "Ed25519",
    value: Buffer.concat([identity, Buffer.alloc(32)]).toString("base64"),
    publicKeyPem: pem,
    divergence:
      "the CLI accepts this signature, and it would accept it for any message: under the identity point as a key, R = identity and S = 0 satisfy the verification equation for every input. The viewer verifies strictly and refuses a small-order key or R, because a key that verifies everything proves nothing",
    viewer: { ok: false, kind: "signature-invalid", message: "signature does not match" },
  });
}
add("ed25519 key given for ECDSA-P256-SHA256", {
  algorithm: "ECDSA-P256-SHA256",
  value: edSignature.toString("base64"),
  publicKeyPem: edPem,
});
{
  const ed448 = generateKeyPairSync("ed448");
  add("ed448 key given for Ed25519", {
    algorithm: "Ed25519",
    value: edSignature.toString("base64"),
    publicKeyPem: publicPem(ed448.publicKey),
  });
}

// --- ECDSA P-256 --------------------------------------------------------------

const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const ecPem = publicPem(ec.publicKey);
const ecSignature = sign("sha256", message(baseEvent), {
  key: ec.privateKey,
  dsaEncoding: "ieee-p1363",
});

add("ecdsa valid", {
  algorithm: "ECDSA-P256-SHA256",
  value: ecSignature.toString("base64"),
  publicKeyPem: ecPem,
});
{
  const r = ecSignature.subarray(0, 32);
  const s = toBigInt(ecSignature.subarray(32));
  const flipped = Buffer.concat([r, fromBigInt(P256_ORDER - s, 32)]);
  add("ecdsa the other S (n - s)", {
    algorithm: "ECDSA-P256-SHA256",
    value: flipped.toString("base64"),
    publicKeyPem: ecPem,
  });
}
add("ecdsa r = 0", {
  algorithm: "ECDSA-P256-SHA256",
  value: Buffer.concat([Buffer.alloc(32), ecSignature.subarray(32)]).toString("base64"),
  publicKeyPem: ecPem,
});
add("ecdsa s = n", {
  algorithm: "ECDSA-P256-SHA256",
  value: Buffer.concat([ecSignature.subarray(0, 32), fromBigInt(P256_ORDER, 32)]).toString(
    "base64",
  ),
  publicKeyPem: ecPem,
});
{
  const der = sign("sha256", message(baseEvent), { key: ec.privateKey, dsaEncoding: "der" });
  add("ecdsa DER encoding instead of P1363", {
    algorithm: "ECDSA-P256-SHA256",
    value: der.toString("base64"),
    publicKeyPem: ecPem,
  });
}
{
  const p384 = generateKeyPairSync("ec", { namedCurve: "secp384r1" });
  add("P-384 key given for ECDSA-P256-SHA256", {
    algorithm: "ECDSA-P256-SHA256",
    value: ecSignature.toString("base64"),
    publicKeyPem: publicPem(p384.publicKey),
  });
}
add("ecdsa key given for Ed25519", {
  algorithm: "Ed25519",
  value: edSignature.toString("base64"),
  publicKeyPem: ecPem,
});

// --- RSA-PSS ------------------------------------------------------------------

function pss(privateKey, saltLength) {
  return sign("sha256", message(baseEvent), {
    key: privateKey,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength,
  });
}

const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rsaPem = publicPem(rsa.publicKey);

for (const [label, saltLength] of [
  ["maximum", constants.RSA_PSS_SALTLEN_MAX_SIGN],
  ["equal to the digest (32)", 32],
  ["20", 20],
  ["zero", 0],
]) {
  add(`rsa-pss salt ${label}`, {
    algorithm: "RSA-PSS-SHA256",
    value: pss(rsa.privateKey, saltLength).toString("base64"),
    publicKeyPem: rsaPem,
  });
}
{
  const valid = pss(rsa.privateKey, 32);
  const flipped = Buffer.from(valid);
  flipped[flipped.length - 1] ^= 0x01;
  add("rsa-pss one bit flipped", {
    algorithm: "RSA-PSS-SHA256",
    value: flipped.toString("base64"),
    publicKeyPem: rsaPem,
  });
}
{
  const modulus = toBigInt(Buffer.from(rsa.publicKey.export({ format: "jwk" }).n, "base64url"));
  add("rsa-pss signature not below the modulus", {
    algorithm: "RSA-PSS-SHA256",
    value: fromBigInt(modulus + 1n, 256)
      .subarray(-256)
      .toString("base64"),
    publicKeyPem: rsaPem,
  });
}
add("rsa-pss one byte short", {
  algorithm: "RSA-PSS-SHA256",
  value: pss(rsa.privateKey, 32).subarray(1).toString("base64"),
  publicKeyPem: rsaPem,
});
{
  const rsa3072 = generateKeyPairSync("rsa", { modulusLength: 3072 });
  add("rsa-pss 3072-bit key", {
    algorithm: "RSA-PSS-SHA256",
    value: pss(rsa3072.privateKey, 32).toString("base64"),
    publicKeyPem: publicPem(rsa3072.publicKey),
  });
}
{
  const rsa1024 = generateKeyPairSync("rsa", { modulusLength: 1024 });
  add("rsa-pss 1024-bit key refused", {
    algorithm: "RSA-PSS-SHA256",
    value: pss(rsa1024.privateKey, 32).toString("base64"),
    publicKeyPem: publicPem(rsa1024.publicKey),
  });
}
{
  const unrestricted = generateKeyPairSync("rsa-pss", { modulusLength: 2048 });
  add("rsa-pss key type without parameters", {
    algorithm: "RSA-PSS-SHA256",
    value: pss(unrestricted.privateKey, 32).toString("base64"),
    publicKeyPem: publicPem(unrestricted.publicKey),
  });
}
{
  const restricted = generateKeyPairSync("rsa-pss", {
    modulusLength: 2048,
    hashAlgorithm: "sha256",
    mgf1HashAlgorithm: "sha256",
    saltLength: 32,
  });
  // A signature with a salt shorter than the key allows cannot be made here:
  // OpenSSL refuses to sign it. The viewer refuses the key before it would
  // matter, so the one case below covers what the viewer does.
  const divergence =
    "an RSASSA-PSS key that restricts its own parameters is refused rather than evaluated; the viewer does not read those parameters, so it does not claim to check a signature under them";
  const viewer = {
    ok: false,
    kind: "signature-invalid",
    message:
      "the supplied RSASSA-PSS public key restricts its own parameters, which this viewer does not evaluate",
  };
  add("rsa-pss key restricted to SHA-256, salt 32", {
    algorithm: "RSA-PSS-SHA256",
    value: pss(restricted.privateKey, 32).toString("base64"),
    publicKeyPem: publicPem(restricted.publicKey),
    divergence,
    viewer,
  });
}
add("rsa key given for Ed25519", {
  algorithm: "Ed25519",
  value: edSignature.toString("base64"),
  publicKeyPem: rsaPem,
});

// --- Hand-built RSA keys and encodings ----------------------------------------
//
// OpenSSL will not make these, so they are built from primes: a modulus one bit
// past a byte boundary, whose encoded message is a byte shorter than the
// modulus and whose leading byte must be zero, and public exponents larger
// than the RSA crate accepts by default.

function modPow(base, exponent, modulus) {
  let result = 1n;
  base %= modulus;
  while (exponent > 0n) {
    if (exponent & 1n) result = (result * base) % modulus;
    base = (base * base) % modulus;
    exponent >>= 1n;
  }
  return result;
}

function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

function inverse(a, modulus) {
  let [oldR, r] = [a, modulus];
  let [oldS, s] = [1n, 0n];
  while (r) {
    const q = oldR / r;
    [oldR, r] = [r, oldR - q * r];
    [oldS, s] = [s, oldS - q * s];
  }
  return ((oldS % modulus) + modulus) % modulus;
}

function jwkNumber(value) {
  const hex = value.toString(16);
  return Buffer.from(hex.length % 2 === 0 ? hex : `0${hex}`, "hex").toString("base64url");
}

function rsaKeyFromPrimes(pBits, qBits, modulusBits, exponent = 65537n) {
  for (;;) {
    const p = generatePrimeSync(pBits, { bigint: true });
    const q = generatePrimeSync(qBits, { bigint: true });
    const n = p * q;
    const phi = (p - 1n) * (q - 1n);
    if (p === q || n.toString(2).length !== modulusBits || gcd(exponent, phi) !== 1n) continue;
    const d = inverse(exponent, phi);
    return createPrivateKey({
      format: "jwk",
      key: {
        kty: "RSA",
        n: jwkNumber(n),
        e: jwkNumber(exponent),
        d: jwkNumber(d),
        p: jwkNumber(p),
        q: jwkNumber(q),
        dp: jwkNumber(d % (p - 1n)),
        dq: jwkNumber(d % (q - 1n)),
        qi: jwkNumber(inverse(q, p)),
      },
    });
  }
}

function sha256(...parts) {
  const hash = createHash("sha256");
  for (const part of parts) hash.update(part);
  return hash.digest();
}

function mgf1(seed, length) {
  const blocks = [];
  for (let counter = 0; blocks.length * 32 < length; counter += 1) {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(counter);
    blocks.push(sha256(seed, c));
  }
  return Buffer.concat(blocks).subarray(0, length);
}

/**
 * An RSASSA-PSS signature built by hand, so that one part of the encoding can
 * be wrong on purpose. `leadingByte` sets the byte an 8k+1-bit modulus
 * carries in front of the encoded message, which must be zero. Returns
 * undefined when the chosen encoding is not below the modulus.
 */
function handmadePss(privateKey, { saltLength = 32, leadingByte = 0 } = {}) {
  const jwk = privateKey.export({ format: "jwk" });
  const n = toBigInt(Buffer.from(jwk.n, "base64url"));
  const d = toBigInt(Buffer.from(jwk.d, "base64url"));
  const modulusBits = n.toString(2).length;
  const k = Math.ceil(modulusBits / 8);
  const emBits = modulusBits - 1;
  const emLength = Math.ceil(emBits / 8);
  const salt = Buffer.alloc(saltLength, 0x5a);
  const h = sha256(Buffer.alloc(8), sha256(message(baseEvent)), salt);
  const db = Buffer.alloc(emLength - 33);
  db[emLength - saltLength - 34] = 0x01;
  salt.copy(db, emLength - saltLength - 33);
  const mask = mgf1(h, db.length);
  for (let index = 0; index < db.length; index += 1) db[index] ^= mask[index];
  db[0] &= 0xff >> (8 * emLength - emBits);
  const encoded = Buffer.concat([Buffer.alloc(k - emLength), db, h, Buffer.from([0xbc])]);
  if (leadingByte !== 0) {
    if (k === emLength) throw new Error("this modulus has no leading byte");
    encoded[0] = leadingByte;
  }
  const m = toBigInt(encoded);
  if (m >= n) return undefined;
  return fromBigInt(modPow(m, d, n), k).toString("base64");
}

{
  // 2049 bits: one bit past 2048, so the encoded message is 256 bytes in a
  // 257-byte block and the byte in front of it has to be zero.
  const odd = rsaKeyFromPrimes(1025, 1024, 2049);
  const oddPem = publicPem(createPublicKey(odd));
  add("rsa-pss 2049-bit key, handmade salt 32", {
    algorithm: "RSA-PSS-SHA256",
    value: handmadePss(odd),
    publicKeyPem: oddPem,
  });
  add("rsa-pss 2049-bit key, salt chosen by OpenSSL", {
    algorithm: "RSA-PSS-SHA256",
    value: sign("sha256", message(baseEvent), {
      key: odd,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_MAX_SIGN,
    }).toString("base64"),
    publicKeyPem: oddPem,
  });
  let forged;
  for (const saltLength of [32, 0, 1, 2, 3, 4, 5, 6, 7, 8]) {
    forged = handmadePss(odd, { saltLength, leadingByte: 1 });
    if (forged !== undefined) break;
  }
  if (forged === undefined) throw new Error("no leading-byte signature fitted below the modulus");
  add("rsa-pss 2049-bit key, non-zero byte before the encoded message", {
    algorithm: "RSA-PSS-SHA256",
    value: forged,
    publicKeyPem: oddPem,
  });
}
{
  // A valid signature plus the modulus: the same residue, not the same value.
  for (;;) {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const n = toBigInt(Buffer.from(pair.publicKey.export({ format: "jwk" }).n, "base64url"));
    const valid = pss(pair.privateKey, 32);
    const raised = toBigInt(valid) + n;
    if (raised >= 1n << 2048n) continue;
    add("rsa-pss valid signature plus the modulus", {
      algorithm: "RSA-PSS-SHA256",
      value: fromBigInt(raised, 256).toString("base64"),
      publicKeyPem: publicPem(pair.publicKey),
    });
    break;
  }
}
for (const [label, exponent, bits] of [
  ["2^33 + 1", (1n << 33n) + 1n, 2048],
  ["2^64 + 13", (1n << 64n) + 13n, 2048],
  ["3", 3n, 2048],
  ["2^64 + 13 on a 4096-bit key", (1n << 64n) + 13n, 4096],
]) {
  const key = rsaKeyFromPrimes(bits / 2, bits / 2, bits, exponent);
  add(`rsa-pss public exponent ${label}`, {
    algorithm: "RSA-PSS-SHA256",
    value: sign("sha256", message(baseEvent), {
      key,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    }).toString("base64"),
    publicKeyPem: publicPem(createPublicKey(key)),
  });
}

// --- Key encodings the CLI loads ------------------------------------------------

function pemOf(der, width = 64) {
  const lines = der.toString("base64").match(new RegExp(`.{1,${width}}`, "g")) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----\n`;
}

{
  const jwk = ec.publicKey.export({ format: "jwk" });
  const x = Buffer.from(jwk.x, "base64url");
  const y = Buffer.from(jwk.y, "base64url");
  const compressed = Buffer.concat([
    Buffer.from("3039301306072a8648ce3d020106082a8648ce3d030107032200", "hex"),
    Buffer.from([2 + (y[31] & 1)]),
    x,
  ]);
  const hybrid = Buffer.concat([
    Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex"),
    Buffer.from([6 + (y[31] & 1)]),
    x,
    y,
  ]);
  add("ecdsa key in compressed point form", {
    algorithm: "ECDSA-P256-SHA256",
    value: ecSignature.toString("base64"),
    publicKeyPem: pemOf(compressed),
  });
  add("ecdsa key in hybrid point form", {
    algorithm: "ECDSA-P256-SHA256",
    value: ecSignature.toString("base64"),
    publicKeyPem: pemOf(hybrid),
  });
  const r = toBigInt(ecSignature.subarray(0, 32));
  if (r + P256_ORDER < 1n << 256n) {
    add("ecdsa r + n", {
      algorithm: "ECDSA-P256-SHA256",
      value: Buffer.concat([fromBigInt(r + P256_ORDER, 32), ecSignature.subarray(32)]).toString(
        "base64",
      ),
      publicKeyPem: ecPem,
    });
  }
}
{
  const der = ed.publicKey.export({ type: "spki", format: "der" });
  for (const [label, pemText] of [
    [
      "on one line",
      `-----BEGIN PUBLIC KEY-----\n${der.toString("base64")}\n-----END PUBLIC KEY-----\n`,
    ],
    ["in 76-column lines", pemOf(der, 76)],
    ["with CRLF line endings", pemOf(der).replace(/\n/g, "\r\n")],
    ["followed by other text", `${pemOf(der)}comment: the producer's signing key\n`],
    ["preceded by other text", `Producer signing key\n${pemOf(der)}`],
    ["followed by a second key", `${pemOf(der)}${publicPem(ec.publicKey)}`],
  ]) {
    add(`ed25519 key PEM ${label}`, {
      algorithm: "Ed25519",
      value: edBase64,
      publicKeyPem: pemText,
    });
  }
}

// --- Ed25519 small-order R under a genuine key -------------------------------

{
  // R = identity is a nonce of zero. Built with the real private scalar, so
  // the equation holds; RFC 8032 permits it, OpenSSL accepts it, and a strict
  // verifier refuses it because it is exactly how the trivial forgery above is
  // shaped.
  const jwk = ed.privateKey.export({ format: "jwk" });
  const seed = Buffer.from(jwk.d, "base64url");
  const publicPoint = Buffer.from(jwk.x, "base64url");
  const expanded = Buffer.from(createHash("sha512").update(seed).digest().subarray(0, 32));
  expanded[0] &= 248;
  expanded[31] &= 127;
  expanded[31] |= 64;
  const littleEndian = (bytes) => toBigInt(Buffer.from(bytes).reverse());
  const a = littleEndian(expanded);
  const identity = Buffer.alloc(32);
  identity[0] = 1;
  const k =
    littleEndian(
      createHash("sha512").update(identity).update(publicPoint).update(message(baseEvent)).digest(),
    ) % ED25519_ORDER;
  const s = (k * a) % ED25519_ORDER;
  add("ed25519 genuine key, R = identity", {
    algorithm: "Ed25519",
    value: Buffer.concat([identity, fromBigInt(s, 32, true)]).toString("base64"),
    publicKeyPem: edPem,
    divergence:
      "R is the identity point, a nonce of zero: the CLI accepts it and so does RFC 8032. The viewer verifies strictly and refuses a small-order R, because a zero nonce is the shape of the trivial forgery recorded above, and no honest signer produces one",
    viewer: { ok: false, kind: "signature-invalid", message: "signature does not match" },
  });
}
{
  // Encodings of y that are not points, or are small-order points.
  for (const y of [2, 3, 4, 5]) {
    const point = Buffer.alloc(32);
    point[0] = y;
    add(`ed25519 key y = ${y}`, {
      algorithm: "Ed25519",
      value: edBase64,
      publicKeyPem: pemOf(Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), point])),
    });
  }
}

// --- Declared algorithm -------------------------------------------------------

add("an algorithm the verifier does not implement", {
  algorithm: "HMAC-SHA256",
  value: edSignature.toString("base64"),
  publicKeyPem: edPem,
});

writeFileSync(
  outputPath,
  `${JSON.stringify({ generatedFrom: "@openauditmodel/cli", vectors }, null, 2)}\n`,
);
console.log(`wrote ${vectors.length} vectors to ${outputPath}`);
