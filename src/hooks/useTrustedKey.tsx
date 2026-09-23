/**
 * The public key trusted for this session, shared by every view that verifies.
 *
 * One key at a time, chosen by the user in a native dialog and held in Rust
 * (see lib/integrity/trusted-key.ts). Nothing is remembered between runs: which
 * key is trusted is a decision the user makes each session, not one a
 * settings file makes for them — a key left trusted from an earlier archive
 * would verify the next one's signatures under the wrong producer's name.
 *
 * Every consumer receives the same `verifier` object until the key changes, so
 * a view can list it as an effect dependency and verify again exactly when the
 * key does.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import {
  chooseTrustedKey,
  currentTrustedKey,
  forgetTrustedKey,
  trustedKeyVerifier,
  type KeySummary,
  type SignatureVerifier,
} from "../lib/integrity/trusted-key";

interface TrustedKeyValue {
  readonly key: KeySummary | undefined;
  readonly verifier: SignatureVerifier | undefined;
  /** Why the last attempt to choose a key failed, until the next attempt. */
  readonly error: string | undefined;
  readonly choose: () => Promise<void>;
  readonly forget: () => Promise<void>;
}

const TrustedKeyContext = createContext<TrustedKeyValue>({
  key: undefined,
  verifier: undefined,
  error: undefined,
  choose: async () => {},
  forget: async () => {},
});

export function TrustedKeyProvider({ children }: { readonly children: ReactNode }) {
  const [key, setKey] = useState<KeySummary | undefined>();
  const [error, setError] = useState<string | undefined>();

  // The Rust side outlives a webview reload; start from what it holds.
  useEffect(() => {
    currentTrustedKey()
      .then(setKey)
      .catch(() => setKey(undefined));
  }, []);

  const choose = useCallback(async () => {
    setError(undefined);
    try {
      const chosen = await chooseTrustedKey();
      if (chosen !== undefined) {
        setKey(chosen);
      }
    } catch (cause) {
      // A refused file leaves the previously trusted key trusted, and says why.
      setError(String(cause));
    }
  }, []);

  const forget = useCallback(async () => {
    setError(undefined);
    await forgetTrustedKey();
    setKey(undefined);
  }, []);

  const verifier = useMemo(() => (key === undefined ? undefined : trustedKeyVerifier(key)), [key]);

  const value = useMemo(
    () => ({ key, verifier, error, choose, forget }),
    [key, verifier, error, choose, forget],
  );
  return <TrustedKeyContext.Provider value={value}>{children}</TrustedKeyContext.Provider>;
}

export function useTrustedKey(): TrustedKeyValue {
  return useContext(TrustedKeyContext);
}
