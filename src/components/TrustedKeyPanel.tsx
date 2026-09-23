/**
 * Choosing, showing and forgetting the key signatures are verified with.
 *
 * The fingerprint is shown in full because it is the one thing a person can
 * compare with whoever published the key: a file name says nothing about whose
 * key it is, and a key that arrived in the same folder as the logs proves only
 * that whoever wrote the logs also wrote a key.
 */
import { useTrustedKey } from "../hooks/useTrustedKey";
import { formatFingerprint } from "../lib/integrity/trusted-key";

interface Props {
  /** Events whose `integrity.signature` declares an algorithm, by algorithm. */
  readonly declared: ReadonlyMap<string, number>;
}

function describeKey(keyType: string, curve?: string, modulusBits?: number): string {
  if (curve !== undefined) return `${keyType} (${curve})`;
  if (modulusBits !== undefined) return `${keyType} ${modulusBits}-bit`;
  return keyType;
}

export function TrustedKeyPanel({ declared }: Props) {
  const { key, error, choose, forget } = useTrustedKey();
  const signed = [...declared.values()].reduce((sum, count) => sum + count, 0);

  return (
    <div className="trusted-key">
      <div className="sweep-row">
        <span className="detail-note-inline">
          {signed === 0
            ? "No event declares a signature."
            : `${signed} event${signed === 1 ? " declares" : "s declare"} a signature: ${[
                ...declared.entries(),
              ]
                .map(([algorithm, count]) => `${algorithm} ${count}`)
                .join(", ")}.`}
        </span>
      </div>

      {key === undefined ? (
        <div className="sweep-row">
          <button type="button" className="secondary-button" onClick={() => void choose()}>
            Choose a public key…
          </button>
          <span className="detail-note-inline">
            Signatures are reported as declared but not checked until you choose the producer's
            public key. Take it from where the producer publishes it — never from beside the logs.
          </span>
        </div>
      ) : (
        <div className="key-summary">
          <div className="rule-line">
            <span className="label">Verifying with</span>
            <span>
              {describeKey(key.keyType, key.curve, key.modulusBits)} · <code>{key.fileName}</code>
            </span>
          </div>
          <div className="rule-line">
            <span className="label">SHA-256 fingerprint</span>
            <code className="fingerprint">{formatFingerprint(key.fingerprint)}</code>
          </div>
          {key.usableFor.length === 0 ? (
            <div className="check-bad rule-line">
              No algorithm this viewer verifies can use this key, so every signature checked with it
              will fail.
            </div>
          ) : [...declared.keys()].some((algorithm) => !key.usableFor.includes(algorithm)) ? (
            <div className="check-bad rule-line">
              This key verifies {key.usableFor.join(", ")} only; signatures in any other algorithm
              will fail against it.
            </div>
          ) : null}
          <div className="sweep-row">
            <button type="button" className="secondary-button" onClick={() => void choose()}>
              Choose another…
            </button>
            <button type="button" className="secondary-button" onClick={() => void forget()}>
              Forget key
            </button>
            <span className="detail-note-inline">
              Trusted for this session only. Compare the fingerprint with the one the producer
              publishes: <code>grep -v -- ----- key.pem | base64 -d | shasum -a 256</code>
            </span>
          </div>
        </div>
      )}

      {error !== undefined ? <div className="check-bad rule-line">{error}</div> : null}
    </div>
  );
}
