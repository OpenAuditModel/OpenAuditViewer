/**
 * The shell every analysis block in the detail panel shares: a coloured
 * swatch, a label, an optional status on the right, and a body.
 *
 * Extracted because the blocks are a list that grows — privacy, integrity,
 * flow, profiles, chain, change so far — and each one repeating the same
 * markup is how a panel ends up with six subtly different headers.
 */
import type { ReactNode } from "react";

/** Which analysis the block belongs to; drives the swatch colour only. */
export type BlockSwatch = "privacy" | "integrity" | "chain" | "resource";

/** How the status on the right should read. `pending` is work in progress. */
export type BlockTone = "ok" | "warn" | "bad" | "pending";

const TONE_CLASS: Readonly<Record<BlockTone, string>> = {
  ok: "count-ok",
  warn: "count-warn",
  bad: "count-bad",
  pending: "count-pending",
};

interface Props {
  readonly label: string;
  readonly swatch: BlockSwatch;
  readonly status?: string;
  readonly tone?: BlockTone;
  readonly children?: ReactNode;
}

export function DetailBlock({ label, swatch, status, tone = "ok", children }: Props) {
  return (
    <div className="block">
      <div className="block-head">
        <span className="label">
          <span className={`swatch ${swatch}`}></span>
          {label}
        </span>
        {status === undefined ? null : <span className={TONE_CLASS[tone]}>{status}</span>}
      </div>
      {children === undefined ? null : <div className="block-body">{children}</div>}
    </div>
  );
}

/** `1 finding` / `2 findings`, without the caller counting characters. */
export function plural(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
