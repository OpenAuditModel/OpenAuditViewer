/**
 * Reading a window of a Kafka topic, through the Rust commands in
 * `src-tauri/src/kafka.rs`.
 *
 * The webview never names a broker address to connect to and never sees a
 * password after it is typed: it asks to save a source (which Rust confirms in
 * a native dialog), and asks to read from a saved one by its identifier.
 * Records come back a batch at a time and become rows here, exactly as lines
 * of a JSON Lines file do, so every engine that judges a folder judges a
 * window the same way. Where a record came from — topic, partition, offset —
 * is its label, beside the event, never inside it.
 */
import { Channel, invoke } from "@tauri-apps/api/core";
import { parseRecord } from "./parse";
import type {
  LoadedEvent,
  LoadSummary,
  StreamWindowSummary,
  WindowPartition,
  WindowStop,
} from "./types";

export type Security = "plaintext" | "tls" | "sasl-tls";
export type SaslMechanism = "PLAIN" | "SCRAM-SHA-256" | "SCRAM-SHA-512";

/** A saved source, as Rust describes it. Never carries a password. */
export interface KafkaSource {
  readonly id: string;
  readonly name: string;
  readonly bootstrapServers: readonly string[];
  readonly topic: string;
  readonly security: Security;
  readonly mechanism?: SaslMechanism;
  readonly username?: string;
  readonly ca?: { readonly label: string; readonly certificates: number };
}

/** A CA certificate chosen in the native dialog. */
export interface ChosenCa {
  readonly label: string;
  readonly pem: string;
  readonly certificates: number;
}

export type CaDraft =
  | { readonly kind: "none" }
  | { readonly kind: "keep" }
  | { readonly kind: "new"; readonly label: string; readonly pem: string };

/** A source as the form asks for it to be saved. */
export interface SourceDraft {
  readonly id?: string;
  readonly name: string;
  readonly bootstrapServers: readonly string[];
  readonly topic: string;
  readonly security: Security;
  readonly mechanism?: SaslMechanism;
  readonly username?: string;
  /** Absent to keep the saved password; Rust allows that only while the
   * brokers, protection, mechanism, user and CA are unchanged. */
  readonly password?: string;
  readonly ca: CaDraft;
}

export type Start =
  | { readonly kind: "earliest" }
  | { readonly kind: "latest"; readonly count: number }
  | { readonly kind: "timestamp"; readonly millis: number }
  | { readonly kind: "offset"; readonly offset: number }
  | {
      readonly kind: "offsets";
      readonly offsets: readonly { readonly partition: number; readonly offset: number }[];
    };

export type End =
  | { readonly kind: "now" }
  | { readonly kind: "timestamp"; readonly millis: number }
  | { readonly kind: "offset"; readonly offset: number };

export type Select =
  | { readonly kind: "all" }
  | { readonly kind: "oldest"; readonly count: number }
  | { readonly kind: "newest"; readonly count: number };

/** Which records are kept, by what they hold. Empty fields match everything. */
export interface Filter {
  readonly contains?: string;
  readonly eventNamePrefix?: string;
  readonly application?: string;
}

export interface ReadRequest {
  readonly partitions?: readonly number[];
  readonly start: Start;
  readonly end?: End;
  readonly select?: Select;
  readonly filter?: Filter;
  readonly maxEvents: number;
  /** Go on reading what arrives after the window, until stopped. */
  readonly follow?: boolean;
}

/** One record as Rust hands it back. */
export interface KafkaRecord {
  readonly partition: number;
  readonly offset: number;
  readonly timestampMillis?: number;
  readonly payload?: string;
  readonly problem?: string;
}

type ReadEvent =
  | { readonly kind: "records"; readonly records: readonly KafkaRecord[] }
  | { readonly kind: "caught-up"; readonly partitions: readonly WindowPartition[] }
  | { readonly kind: "progress"; readonly scanned: number; readonly kept: number };

interface ReadResult {
  readonly source: KafkaSource;
  readonly report: {
    readonly topic: string;
    readonly partitions: readonly WindowPartition[];
    readonly scanned: number;
    readonly records: number;
    readonly followed: number;
    readonly bytes: number;
    readonly caughtUp: boolean;
    readonly stop: Exclude<WindowStop, "listening">;
  };
  readonly maxEvents: number;
}

/** The viewer's ceiling on events held at once, the same as for a folder. */
export const MAX_WINDOW_EVENTS = 100_000;

export function listSources(): Promise<KafkaSource[]> {
  return invoke<KafkaSource[]>("kafka_sources");
}

/** Saves a source after the native confirmation; undefined when the user declined. */
export async function saveSource(draft: SourceDraft): Promise<KafkaSource | undefined> {
  const saved = await invoke<KafkaSource | null>("kafka_save_source", { draft });
  return saved ?? undefined;
}

/** Deletes a source after the native confirmation; false when the user declined. */
export function deleteSource(id: string): Promise<boolean> {
  return invoke<boolean>("kafka_delete_source", { id });
}

export async function chooseCa(): Promise<ChosenCa | undefined> {
  const chosen = await invoke<ChosenCa | null>("kafka_choose_ca");
  return chosen ?? undefined;
}

export function cancelRead(): Promise<void> {
  return invoke<void>("kafka_cancel_read");
}

/** Where a source lives, as the toolbar and the report name it. */
export function locationOf(source: Pick<KafkaSource, "name" | "topic">): string {
  return `kafka://${source.name}/${source.topic}`;
}

/** A record's label: its location, then partition@offset. */
export function recordLabel(
  location: string,
  record: Pick<KafkaRecord, "partition" | "offset">,
): string {
  return `${location}/${record.partition}@${record.offset}`;
}

/** The rows a batch of records becomes. */
export function rowsFromRecords(location: string, records: readonly KafkaRecord[]): LoadedEvent[] {
  return records.map((record) =>
    parseRecord(recordLabel(location, record), record.payload, record.problem),
  );
}

/** How a source's connection is protected, in words. */
export function describeProtection(
  source: Pick<KafkaSource, "security" | "mechanism" | "username" | "ca">,
): string {
  const trust = source.ca === undefined ? "public CAs" : `the CA in ${source.ca.label}`;
  switch (source.security) {
    case "plaintext":
      return "no TLS — records crossed the network unencrypted";
    case "tls":
      return `TLS, broker verified against ${trust}`;
    case "sasl-tls":
      return `TLS, broker verified against ${trust}; SASL ${source.mechanism ?? ""} as ${source.username ?? ""}`;
  }
}

/** Where reading started, in words. */
export function describeStart(start: Start): string {
  switch (start.kind) {
    case "earliest":
      return "the oldest record each partition held";
    case "latest":
      return `the newest ${start.count} record${start.count === 1 ? "" : "s"} of each partition`;
    case "timestamp":
      return `the first record at or after ${new Date(start.millis).toISOString()}`;
    case "offset":
      return `offset ${start.offset} of each partition, or the nearest it held`;
    case "offsets":
      return start.offsets
        .map((entry) => `offset ${entry.offset} of partition ${entry.partition}`)
        .join(", ");
  }
}

/** What was asked for, in words: the range, and what was kept of it. */
export function describeRequest(request: ReadRequest): string {
  const select = request.select ?? { kind: "all" };
  let range: string;
  if (select.kind === "newest") {
    range = `the newest ${select.count.toLocaleString()} records across the topic`;
  } else if (select.kind === "oldest") {
    range = `the oldest ${select.count.toLocaleString()} records across the topic`;
  } else {
    range = `from ${describeStart(request.start)}`;
    const end = request.end ?? { kind: "now" };
    if (end.kind === "timestamp") {
      range += ` until ${new Date(end.millis).toISOString()}`;
    } else if (end.kind === "offset") {
      range += ` to offset ${end.offset} of each partition`;
    }
  }
  return request.follow === true ? `${range}, then listening for new records` : range;
}

/** The read-time filter, in words; undefined when there is none. */
export function describeFilter(filter: Filter | undefined): string | undefined {
  if (filter === undefined) {
    return undefined;
  }
  const parts: string[] = [];
  if (filter.eventNamePrefix !== undefined && filter.eventNamePrefix.trim() !== "") {
    parts.push(`event name starts with "${filter.eventNamePrefix.trim()}"`);
  }
  if (filter.application !== undefined && filter.application.trim() !== "") {
    parts.push(`application is "${filter.application.trim()}"`);
  }
  if (filter.contains !== undefined && filter.contains.trim() !== "") {
    parts.push(`the record contains "${filter.contains.trim()}"`);
  }
  return parts.length === 0 ? undefined : parts.join(", and ");
}

/** Whether a window read every partition of the topic from its first offset
 * to its end, unfiltered: then it has no holes of its own making. */
function hasEdges(
  request: ReadRequest,
  partitions: readonly WindowPartition[],
  complete: boolean,
): boolean {
  const everything =
    request.start.kind === "earliest" &&
    (request.select === undefined || request.select.kind === "all") &&
    request.partitions === undefined &&
    describeFilter(request.filter) === undefined;
  const fromTheFirstOffset = partitions.every(
    (partition) => partition.lowOffset === 0 && partition.startOffset === 0,
  );
  return !(everything && fromTheFirstOffset && complete);
}

/** The load summary a window becomes: no files, a window. */
export function windowSummary(
  source: KafkaSource,
  request: ReadRequest,
  report: {
    readonly topic: string;
    readonly partitions: readonly WindowPartition[];
    readonly scanned: number;
    readonly records: number;
    readonly followed: number;
    readonly caughtUp?: boolean;
    readonly stop: WindowStop;
  },
  maxEvents: number,
  readAt: Date = new Date(),
  error?: string,
): LoadSummary {
  const filter = describeFilter(request.filter);
  const listened =
    request.follow === true && (report.caughtUp === true || report.stop === "listening");
  const complete = report.stop === "end-of-window" || listened;
  const window: StreamWindowSummary = {
    sourceName: source.name,
    bootstrapServers: source.bootstrapServers,
    topic: report.topic,
    protection: describeProtection(source),
    start: describeRequest(request),
    ...(filter === undefined ? {} : { filter }),
    partitions: report.partitions,
    scanned: report.scanned,
    records: report.records,
    followed: report.followed,
    stop: report.stop,
    listened,
    edges: hasEdges(request, report.partitions, complete),
    ...(error === undefined ? {} : { error }),
    maxEvents,
    readAt: readAt.toISOString(),
  };
  return {
    filesRead: 0,
    filesFound: 0,
    filesFailed: [],
    filesSkipped: [],
    directoriesSkipped: [],
    directoriesFailed: [],
    truncated: false,
    eventLimit: maxEvents,
    window,
  };
}

/** What the progress line says while a read runs. */
export interface ReadProgress {
  /** Records read from the broker, kept or not. */
  readonly scanned: number;
  /** Records kept — the ones that match, when filtering. */
  readonly kept: number;
}

/**
 * New records arriving after the window, while listening. Rows are handed
 * over at most once a second, with a summary that counts them, so a busy
 * topic does not re-render the app for every record; the end comes once,
 * with the summary of everything read, and nothing comes after it.
 */
export interface LiveFeed {
  subscribe(
    onRows: (rows: LoadedEvent[], summary: LoadSummary) => void,
    onEnd: (summary: LoadSummary) => void,
  ): void;
  stop(): Promise<void>;
}

export interface ReadOutcome {
  readonly events: LoadedEvent[];
  readonly summary: LoadSummary;
  readonly location: string;
  /** Present when listening goes on after the window. */
  readonly live?: LiveFeed;
}

/** How often rows that arrived while listening are handed to the app. */
const LIVE_FLUSH_MS = 1000;

/**
 * Reads one window of a saved source. Rows are built as batches arrive, so
 * the webview never holds the raw records and the rows at once for long.
 *
 * Without `follow`, resolves when the read ends. With it, resolves as soon as
 * the window is read, with a live feed that hands over what arrives next and
 * says when listening stops.
 */
export function readWindow(
  source: KafkaSource,
  request: ReadRequest,
  onProgress: (progress: ReadProgress) => void,
): Promise<ReadOutcome> {
  const location = locationOf(source);
  const events: LoadedEvent[] = [];
  const maxEvents = Math.min(Math.max(1, Math.floor(request.maxEvents)), MAX_WINDOW_EVENTS);
  const channel = new Channel<ReadEvent>();

  let caughtUpWith: readonly WindowPartition[] | undefined;
  let received = 0;
  let followed = 0;
  let scanned = 0;
  let expected: number | undefined;
  let allArrived: (() => void) | undefined;
  // Settles the outer promise: at caught-up when listening, at the end otherwise.
  let settle: ((outcome: ReadOutcome) => void) | undefined;
  let settled = false;
  // The live feed's state, once there is one.
  let pending: LoadedEvent[][] = [];
  let liveTimer: ReturnType<typeof setTimeout> | undefined;
  let onRows: ((rows: LoadedEvent[], summary: LoadSummary) => void) | undefined;
  let onEnd: ((summary: LoadSummary) => void) | undefined;
  let ended: LoadSummary | undefined;

  const provisional = (stop: WindowStop = "listening", error?: string): LoadSummary =>
    windowSummary(
      source,
      request,
      {
        topic: source.topic,
        partitions: caughtUpWith ?? [],
        scanned,
        records: received,
        followed,
        caughtUp: caughtUpWith !== undefined,
        stop,
      },
      maxEvents,
      new Date(),
      error,
    );

  const flush = (): void => {
    liveTimer = undefined;
    if (pending.length > 0 && onRows !== undefined) {
      const rows = pending.flat();
      pending = [];
      onRows(rows, ended ?? provisional());
    }
  };

  /** Ends the feed once: the rows still held, then the summary. */
  const end = (summary: LoadSummary): void => {
    if (ended !== undefined) {
      return;
    }
    if (liveTimer !== undefined) {
      clearTimeout(liveTimer);
      liveTimer = undefined;
    }
    ended = summary;
    flush();
    onEnd?.(summary);
  };

  // Channel messages keep their order among themselves, but nothing orders
  // them against the command's own answer: the last batch can arrive after
  // it. The answer says how many records were kept, and the load waits for
  // exactly that many rather than reporting a window short of its end.
  const arrived = new Promise<void>((resolve) => {
    allArrived = resolve;
  });

  channel.onmessage = (message) => {
    if (ended !== undefined) {
      return;
    }
    if (message.kind === "records") {
      const rows = rowsFromRecords(location, message.records);
      received += rows.length;
      if (!settled) {
        for (const row of rows) {
          events.push(row);
        }
      } else {
        followed += rows.length;
        pending.push(rows);
        if (liveTimer === undefined) {
          liveTimer = setTimeout(flush, LIVE_FLUSH_MS);
        }
      }
      if (expected !== undefined && received >= expected) {
        allArrived?.();
      }
    } else if (message.kind === "progress") {
      scanned = message.scanned;
      onProgress({ scanned: message.scanned, kept: message.kept });
    } else {
      caughtUpWith = message.partitions;
      // Listening: the window is read, and every record of it arrived before
      // this message did. Hand it over now; what comes next is new.
      if (request.follow === true && !settled) {
        settled = true;
        settle?.({
          events: [...events],
          summary: provisional(),
          location,
          live: {
            subscribe(rows, finished) {
              onRows = rows;
              onEnd = finished;
              if (ended !== undefined) {
                flush();
                finished(ended);
              }
            },
            stop: cancelRead,
          },
        });
      }
    }
  };

  return new Promise<ReadOutcome>((resolve, reject) => {
    settle = resolve;
    const finish = (result: ReadResult): LoadSummary =>
      windowSummary(result.source, request, result.report, result.maxEvents);

    invoke<ReadResult>("kafka_read", {
      id: source.id,
      request: {
        ...(request.partitions === undefined ? {} : { partitions: request.partitions }),
        start: request.start,
        end: request.end ?? { kind: "now" },
        select: request.select ?? { kind: "all" },
        filter: request.filter ?? {},
        maxEvents,
        follow: request.follow === true,
      },
      events: channel,
    }).then(
      async (result) => {
        expected = result.report.records;
        if (received < expected) {
          const timedOut = new Promise<"timeout">((done) =>
            setTimeout(() => done("timeout"), 10_000),
          );
          if ((await Promise.race([arrived, timedOut])) === "timeout") {
            const message = `the broker sent ${expected} records and ${received} arrived; read again`;
            if (!settled) {
              settled = true;
              reject(new Error(message));
            } else {
              end(provisional("failed", message));
            }
            return;
          }
        }
        if (!settled) {
          settled = true;
          resolve({ events, summary: finish(result), location });
          return;
        }
        end(finish(result));
      },
      (cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        if (!settled) {
          settled = true;
          reject(new Error(message));
          return;
        }
        end(provisional("failed", message));
      },
    );
  });
}

/** Why a window ended, in words, when it ended before its end — or, for a
 * window that went on listening, when listening ended other than by hand. */
export function stopWarning(summary: StreamWindowSummary): string | undefined {
  if (summary.listened) {
    switch (summary.stop) {
      case "event-limit":
        return `Listening stopped at ${summary.maxEvents.toLocaleString()} events, the most one window holds.`;
      case "byte-limit":
        return "Listening stopped at 256 MB of records.";
      case "timed-out":
        return "Listening stopped after eight hours.";
      case "failed":
        return `Listening stopped: ${summary.error ?? "the read failed"}.`;
      default:
        return undefined;
    }
  }
  switch (summary.stop) {
    case "end-of-window":
    case "listening":
      return undefined;
    case "event-limit":
      return `Stopped at ${summary.maxEvents.toLocaleString()} events — the window holds more.`;
    case "byte-limit":
      return "Stopped at 256 MB of records — the window holds more.";
    case "cancelled":
      return "Stopped by hand before the end of the window.";
    case "timed-out":
      return "Stopped after five minutes, before the end of the window.";
    case "stalled":
      return "Stopped because records stopped arriving before the end of the window.";
    case "failed":
      return `Stopped: ${summary.error ?? "the read failed"}.`;
  }
}

/**
 * Parses the partition field: blank for every partition, otherwise a list of
 * non-negative whole numbers separated by commas or spaces.
 */
export function parsePartitions(text: string): number[] | undefined | "invalid" {
  const parts = text
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return undefined;
  }
  const numbers = parts.map((part) => (/^\d{1,9}$/.test(part) ? Number(part) : Number.NaN));
  return numbers.some((value) => Number.isNaN(value)) ? "invalid" : [...new Set(numbers)];
}

/** Splits the bootstrap field into servers: commas, spaces or new lines. */
export function parseServers(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((server) => server.trim())
    .filter((server) => server.length > 0);
}

/**
 * Parses the offset field: one offset for every partition (`120`), or an
 * offset for each partition named (`0:120, 2:40`).
 */
export function parseOffsets(
  text: string,
): number | readonly { partition: number; offset: number }[] | "invalid" {
  const trimmed = text.trim();
  if (/^\d{1,15}$/.test(trimmed)) {
    return Number(trimmed);
  }
  const parts = trimmed
    .split(/[\s,]+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) {
    return "invalid";
  }
  const pairs = parts.map((part) => /^(\d{1,9}):(\d{1,15})$/.exec(part));
  if (pairs.some((pair) => pair === null)) {
    return "invalid";
  }
  const offsets = pairs.map((pair) => ({
    partition: Number((pair as RegExpExecArray)[1]),
    offset: Number((pair as RegExpExecArray)[2]),
  }));
  return new Set(offsets.map((entry) => entry.partition)).size === offsets.length
    ? offsets
    : "invalid";
}

/** The ways the read form offers to choose a window. */
export type ReadMode =
  "newest" | "oldest" | "newest-per-partition" | "time" | "offset" | "everything";

/** The read form's fields, as typed. */
export interface ReadForm {
  readonly mode: ReadMode;
  readonly count: string;
  readonly from: string;
  readonly until: string;
  readonly fromOffset: string;
  readonly untilOffset: string;
  readonly partitions: string;
  readonly contains: string;
  readonly eventNamePrefix: string;
  readonly application: string;
  readonly maxEvents: string;
  readonly follow: boolean;
}

export const DEFAULT_READ_FORM: ReadForm = {
  mode: "newest",
  count: "500",
  from: "",
  until: "",
  fromOffset: "",
  untilOffset: "",
  partitions: "",
  contains: "",
  eventNamePrefix: "",
  application: "",
  maxEvents: "10000",
  follow: false,
};

/** Whether a form's window can go on to listen: only one that ends now, and
 * never the oldest records — what arrives next is not among them. */
export function canFollow(form: ReadForm): boolean {
  return (
    form.mode !== "oldest" &&
    !(form.mode === "time" && form.until.trim() !== "") &&
    !(form.mode === "offset" && form.untilOffset.trim() !== "")
  );
}

/** Whether the form's "at most" field applies: a selection's count is its own limit. */
export function usesEventLimit(form: ReadForm): boolean {
  return !(form.mode === "newest" || form.mode === "oldest") || (form.follow && canFollow(form));
}

/**
 * A whole number as typed: digits, or digits grouped in threes by one kind
 * of separator (`100000`, `100.000`, `100,000`). Anything else — `1.5`,
 * `1,00` — is not a count, rather than a count of something else.
 */
function whole(text: string, low: number, high: number): number | undefined {
  const trimmed = text.trim();
  const grouped = /^\d{1,3}(?:([.,_ ])\d{3})?(?:\1\d{3})*$/.test(trimmed);
  if (!/^\d{1,15}$/.test(trimmed) && !grouped) {
    return undefined;
  }
  const value = Number(trimmed.replaceAll(/[.,_ ]/g, ""));
  return Number.isSafeInteger(value) && value >= low && value <= high ? value : undefined;
}

/** An offset as typed: digits only, as the start offsets are. */
function offsetOf(text: string): number | undefined {
  const trimmed = text.trim();
  return /^\d{1,15}$/.test(trimmed) ? Number(trimmed) : undefined;
}

/** Turns the form into a request, or says what is wrong with it. */
export function buildRequest(form: ReadForm): ReadRequest | string {
  const partitions = parsePartitions(form.partitions);
  if (partitions === "invalid") {
    return "partitions are whole numbers separated by commas; leave it empty for all";
  }
  const follow = form.follow && canFollow(form);
  const limitText = `between 1 and ${MAX_WINDOW_EVENTS.toLocaleString()}`;
  const maxEvents = usesEventLimit(form) ? whole(form.maxEvents, 1, MAX_WINDOW_EVENTS) : undefined;
  if (usesEventLimit(form) && maxEvents === undefined) {
    return `the event limit must be ${limitText}`;
  }

  const filter: Filter = {
    ...(form.contains.trim() === "" ? {} : { contains: form.contains.trim() }),
    ...(form.eventNamePrefix.trim() === "" ? {} : { eventNamePrefix: form.eventNamePrefix.trim() }),
    ...(form.application.trim() === "" ? {} : { application: form.application.trim() }),
  };
  const common = {
    ...(partitions === undefined ? {} : { partitions }),
    ...(Object.keys(filter).length === 0 ? {} : { filter }),
    ...(follow ? { follow } : {}),
  };

  switch (form.mode) {
    case "newest":
    case "oldest":
    case "newest-per-partition": {
      const count = whole(form.count, 1, MAX_WINDOW_EVENTS);
      if (count === undefined) {
        return `the number of records must be ${limitText}`;
      }
      if (form.mode === "newest-per-partition") {
        return {
          ...common,
          start: { kind: "latest", count },
          maxEvents: maxEvents ?? count,
        };
      }
      return {
        ...common,
        start: form.mode === "newest" ? { kind: "latest", count } : { kind: "earliest" },
        select: { kind: form.mode, count },
        maxEvents: Math.max(maxEvents ?? count, count),
      };
    }
    case "time": {
      const from = new Date(form.from).getTime();
      if (form.from.trim() === "" || !Number.isFinite(from) || from < 0) {
        return "choose a date and time to read from";
      }
      let end: End = { kind: "now" };
      if (form.until.trim() !== "") {
        const until = new Date(form.until).getTime();
        if (!Number.isFinite(until) || until <= from) {
          return "the end must be a date and time after the start";
        }
        end = { kind: "timestamp", millis: until };
      }
      return {
        ...common,
        start: { kind: "timestamp", millis: from },
        end,
        maxEvents: maxEvents ?? 1,
      };
    }
    case "offset": {
      const offsets = parseOffsets(form.fromOffset);
      if (offsets === "invalid") {
        return "write one offset for every partition, such as 120, or one for each partition, such as 0:120, 2:40";
      }
      if (typeof offsets !== "number" && partitions !== undefined) {
        return "name the partitions with their offsets, or in the partition list, not both";
      }
      let end: End = { kind: "now" };
      if (form.untilOffset.trim() !== "") {
        const until = offsetOf(form.untilOffset);
        if (until === undefined) {
          return "the end offset must be a whole number, zero or more";
        }
        end = { kind: "offset", offset: until };
      }
      return {
        ...common,
        start:
          typeof offsets === "number"
            ? { kind: "offset", offset: offsets }
            : { kind: "offsets", offsets },
        end,
        maxEvents: maxEvents ?? 1,
      };
    }
    case "everything":
      return { ...common, start: { kind: "earliest" }, maxEvents: maxEvents ?? 1 };
  }
}
