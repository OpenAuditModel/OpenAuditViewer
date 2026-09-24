/**
 * A window read from Kafka, from the moment its records reach the webview.
 *
 * The broker side — what is read, and that nothing is left behind on the
 * broker — is tested in Rust against a real broker
 * (`src-tauri/kafka-source/tests/broker.rs`). What is held here is what the
 * app makes of the records: rows judged exactly as lines of a file are, where
 * each came from kept beside the event, and a chain cut by the window's edge
 * never reported as broken.
 */
import { describe, expect, it, vi } from "vitest";

// A channel the test can speak through, and an invoke it answers by hand.
const tauri = vi.hoisted(() => {
  class FakeChannel<T> {
    onmessage: (message: T) => void = () => undefined;
  }
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  let answer: { resolve: (value: unknown) => void; reject: (cause: unknown) => void } | undefined;
  const invoke = vi.fn((command: string, args: Record<string, unknown> = {}) => {
    calls.push({ command, args });
    if (command !== "kafka_read") {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve, reject) => {
      answer = { resolve, reject };
    });
  });
  return {
    FakeChannel,
    calls,
    invoke,
    answer: () => answer,
    channel: () =>
      calls.filter((call) => call.command === "kafka_read").at(-1)?.args["events"] as
        FakeChannel<unknown> | undefined,
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: tauri.invoke,
  Channel: tauri.FakeChannel,
}));

import {
  DEFAULT_READ_FORM,
  buildRequest,
  canFollow,
  describeFilter,
  describeProtection,
  describeRequest,
  describeStart,
  parseOffsets,
  parsePartitions,
  parseServers,
  recordLabel,
  rowsFromRecords,
  stopWarning,
  usesEventLimit,
  windowSummary,
  type ReadForm,
} from "../kafka";
import { parseJsonLine } from "../parse";
import { calculateDigest } from "../integrity/digest";
import { verifyChains } from "../integrity/chain";
import { chainVerdict } from "../chain-view";
import { isStreamWindow, sourceGroup } from "../stream-window";
import { buildArchiveReport } from "../report";

const location = "kafka://Production audit/audit.events";

function event(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    specVersion: "1.0",
    id,
    time: "2026-09-24T10:00:00.000Z",
    event: { name: "data.record.update", category: "data-modification", outcome: "success" },
    actor: { type: "user", id: "user-1" },
    resource: { type: "record", id: "record-1" },
    application: { name: "kafka-test", environment: "test" },
    ...overrides,
  };
}

describe("records become rows", () => {
  it("a record is judged exactly as the same line of a file is", () => {
    const text = JSON.stringify(event("018f1b70-2c18-7f3a-b46d-000000000901"));
    const [row] = rowsFromRecords(location, [{ partition: 3, offset: 1542, payload: text }]);
    const line = parseJsonLine("a.jsonl", text, 1);
    expect(row?.valid).toBe(true);
    expect(row?.errors).toEqual(line?.errors);
    expect(row?.privacyFindings).toEqual(line?.privacyFindings);
    expect(row?.sourceFormat).toBe("kafka");
    // Where it came from is its label, never a field added to the event.
    expect(row?.sourceFile).toBe(`${location}/3@1542`);
    expect(row?.event).toEqual(JSON.parse(text));
  });

  it("a record that is not an event is a row that says why", () => {
    const rows = rowsFromRecords(location, [
      { partition: 0, offset: 1, payload: "not json" },
      { partition: 0, offset: 2, problem: "the record has no value (a tombstone)" },
    ]);
    expect(rows.map((row) => row.valid)).toEqual([false, false]);
    expect(rows[0]?.errors[0]?.message).toMatch(/not valid JSON/);
    expect(rows[1]?.errors[0]?.message).toBe("the record has no value (a tombstone)");
  });

  it("records group by partition where files group by file", () => {
    const [row] = rowsFromRecords(location, [{ partition: 7, offset: 12, payload: "{}" }]);
    expect(row === undefined ? "" : sourceGroup(row)).toBe(`${location}/7`);
    expect(sourceGroup({ sourceFile: "/logs/a.jsonl", sourceFormat: "jsonl" })).toBe(
      "/logs/a.jsonl",
    );
    expect(recordLabel(location, { partition: 0, offset: 0 })).toBe(`${location}/0@0`);
  });

  it("a window is recognised by its rows, a folder is not", () => {
    expect(
      isStreamWindow(rowsFromRecords(location, [{ partition: 0, offset: 0, payload: "{}" }])),
    ).toBe(true);
    const line = parseJsonLine("a.jsonl", "{}", 1);
    expect(isStreamWindow(line === undefined ? [] : [line])).toBe(false);
    expect(isStreamWindow([])).toBe(false);
  });
});

describe("a chain cut by the window's edge", () => {
  const chainId = "018f1b70-2c18-7f3a-b46d-000000000950";

  async function sealed(sequence: number, previousHash?: string) {
    const unsealed = event(`018f1b70-2c18-7f3a-b46d-${String(950 + sequence).padStart(12, "0")}`, {
      sequence,
      integrity: {
        canonicalization: "RFC8785",
        hashAlgorithm: "SHA-256",
        chainId,
        ...(previousHash === undefined ? {} : { previousHash }),
      },
    });
    const hash = await calculateDigest(unsealed, "SHA-256");
    return { ...unsealed, integrity: { ...(unsealed["integrity"] as object), hash } } as Record<
      string,
      unknown
    > & { integrity: { hash: string } };
  }

  async function chainOfFive() {
    const events = [await sealed(1)];
    for (let sequence = 2; sequence <= 5; sequence += 1) {
      events.push(await sealed(sequence, events[events.length - 1]?.integrity.hash));
    }
    return events;
  }

  it("is not broken where the window left a hole, and not held either", async () => {
    const all = await chainOfFive();
    // Sequences 1, 2 and 5: 3 and 4 were in a partition the window did not read.
    const window = [all[0], all[1], all[4]].map((member, index) => ({
      label: `m${index}`,
      event: member,
    }));

    const asWindow = await verifyChains(window, { windowed: true });
    const chain = asWindow.chains[0];
    expect(chain?.findings.map((finding) => finding.kind)).toEqual(["link-outside-window"]);
    expect(chain?.intact).toBe(false);
    expect(chain === undefined ? undefined : chainVerdict(chain)).toBe("unchecked");

    // The same events from a folder: a missing event breaks the link.
    const asFolder = await verifyChains(window);
    expect(asFolder.chains[0]?.findings.map((finding) => finding.kind)).toEqual(["broken-link"]);
    expect(asFolder.chains[0] === undefined ? undefined : chainVerdict(asFolder.chains[0])).toBe(
      "broken",
    );
  });

  it("is still broken where two neighbours are both in the window and disagree", async () => {
    const all = await chainOfFive();
    const tampered = {
      ...all[2],
      integrity: { ...all[2]?.integrity, previousHash: "0".repeat(64) },
    };
    const rehashed = {
      ...tampered,
      integrity: {
        ...tampered.integrity,
        hash: await calculateDigest(tampered as Record<string, unknown>, "SHA-256"),
      },
    };
    const report = await verifyChains(
      [all[0], all[1], rehashed].map((member, index) => ({ label: `m${index}`, event: member })),
      { windowed: true },
    );
    expect(report.chains[0]?.findings.map((finding) => finding.kind)).toEqual(["broken-link"]);
    expect(report.chains[0] === undefined ? undefined : chainVerdict(report.chains[0])).toBe(
      "broken",
    );
  });

  it("and the report counts it apart from intact and broken chains", async () => {
    const all = await chainOfFive();
    const rows = rowsFromRecords(
      location,
      [all[0], all[1], all[4]].map((member, index) => ({
        partition: 0,
        offset: index,
        payload: JSON.stringify(member),
      })),
    );
    const edged = windowSummary(
      { id: "s", name: "s", bootstrapServers: ["b:9092"], topic: "t", security: "plaintext" },
      { start: { kind: "latest", count: 3 }, maxEvents: 3 },
      { topic: "t", partitions: [], scanned: 3, records: 3, followed: 0, stop: "end-of-window" },
      3,
    );
    const report = await buildArchiveReport(rows, edged, location);
    expect(report.integrity.chains).toMatchObject({ checked: 1, intact: 0, outsideWindow: 1 });
  });

  it("is broken as anywhere when the window read the whole topic from its first offset", async () => {
    // Everything, every partition, unfiltered, from offset 0 to the end: the
    // window left no hole, so a gap is a missing event — a forged successor
    // with a made-up link, or one taken out of the middle.
    const source = {
      id: "s",
      name: "s",
      bootstrapServers: ["b:9092"],
      topic: "t",
      security: "plaintext" as const,
    };
    const whole = windowSummary(
      source,
      { start: { kind: "earliest" }, maxEvents: 100 },
      {
        topic: "t",
        partitions: [
          { partition: 0, startOffset: 0, endOffset: 3, lowOffset: 0, records: 3, complete: true },
        ],
        scanned: 3,
        records: 3,
        followed: 0,
        stop: "end-of-window",
      },
      100,
    );
    expect(whole.window?.edges).toBe(false);
    const all = await chainOfFive();
    const rows = rowsFromRecords(
      location,
      [all[0], all[1], all[4]].map((member, index) => ({
        partition: 0,
        offset: index,
        payload: JSON.stringify(member),
      })),
    );
    const report = await buildArchiveReport(rows, whole, location);
    expect(report.integrity.chains).toMatchObject({ checked: 1, intact: 0, outsideWindow: 0 });

    // Any of these gives the window edges again.
    const edgesOf = (request: Parameters<typeof windowSummary>[1], lowOffset = 0) =>
      windowSummary(
        source,
        request,
        {
          topic: "t",
          partitions: [
            {
              partition: 0,
              startOffset: lowOffset,
              endOffset: 3,
              lowOffset,
              records: 3,
              complete: true,
            },
          ],
          scanned: 3,
          records: 3,
          followed: 0,
          stop: "end-of-window",
        },
        100,
      ).window?.edges;
    expect(edgesOf({ start: { kind: "earliest" }, filter: { contains: "x" }, maxEvents: 1 })).toBe(
      true,
    );
    expect(edgesOf({ start: { kind: "earliest" }, partitions: [0], maxEvents: 1 })).toBe(true);
    expect(edgesOf({ start: { kind: "earliest" }, maxEvents: 1 }, 5)).toBe(true);
    expect(
      edgesOf({
        start: { kind: "latest", count: 5 },
        select: { kind: "newest", count: 5 },
        maxEvents: 5,
      }),
    ).toBe(true);
  });
});

describe("what the window says about itself", () => {
  const result = {
    source: {
      id: "s1",
      name: "Production audit",
      bootstrapServers: ["broker-1.example.com:9094"],
      topic: "audit.events",
      security: "sasl-tls" as const,
      mechanism: "SCRAM-SHA-512" as const,
      username: "reader",
    },
    report: {
      topic: "audit.events",
      partitions: [
        {
          partition: 0,
          startOffset: 90,
          endOffset: 100,
          lowOffset: 0,
          records: 10,
          complete: true,
        },
        { partition: 1, startOffset: 40, endOffset: 50, lowOffset: 5, records: 3, complete: false },
      ],
      scanned: 40,
      records: 13,
      followed: 0,
      stop: "event-limit" as const,
    },
    maxEvents: 13,
  };

  it("becomes a load summary with no files and the whole window beside it", () => {
    const summary = windowSummary(
      result.source,
      {
        start: { kind: "latest", count: 10 },
        filter: { eventNamePrefix: "auth." },
        maxEvents: 13,
      },
      result.report,
      result.maxEvents,
      new Date("2026-09-24T10:00:00Z"),
    );
    expect(summary.filesRead).toBe(0);
    expect(summary.window?.records).toBe(13);
    expect(summary.window?.scanned).toBe(40);
    expect(summary.window?.start).toBe("from the newest 10 records of each partition");
    expect(summary.window?.filter).toBe('event name starts with "auth."');
    expect(summary.window?.readAt).toBe("2026-09-24T10:00:00.000Z");
    expect(summary.window?.protection).toMatch(/SCRAM-SHA-512 as reader/);
    expect(summary.window === undefined ? undefined : stopWarning(summary.window)).toMatch(
      /Stopped at 13 events/,
    );
  });

  it("names a connection without TLS for what it is", () => {
    expect(describeProtection({ security: "plaintext" })).toMatch(/unencrypted/);
    expect(
      describeProtection({ security: "tls", ca: { label: "corp-ca.pem", certificates: 1 } }),
    ).toBe("TLS, broker verified against the CA in corp-ca.pem");
  });

  it("describes every start in words", () => {
    expect(describeStart({ kind: "earliest" })).toMatch(/oldest/);
    expect(describeStart({ kind: "offset", offset: 7 })).toMatch(/offset 7/);
    expect(describeStart({ kind: "timestamp", millis: 0 })).toMatch(/1970-01-01T00:00:00.000Z/);
  });
});

describe("the form's text fields", () => {
  it("reads partitions, and blank as every partition", () => {
    expect(parsePartitions("")).toBeUndefined();
    expect(parsePartitions(" 0, 2 2 ,5")).toEqual([0, 2, 5]);
    expect(parsePartitions("1, two")).toBe("invalid");
    expect(parsePartitions("-1")).toBe("invalid");
  });

  it("reads bootstrap servers separated by commas, spaces or lines", () => {
    expect(parseServers(" a:9092,b:9092\nc:9092 ")).toEqual(["a:9092", "b:9092", "c:9092"]);
  });
});

describe("the read form", () => {
  const form = (changes: Partial<ReadForm>): ReadForm => ({ ...DEFAULT_READ_FORM, ...changes });

  it("reads the newest records across the topic by default", () => {
    expect(buildRequest(DEFAULT_READ_FORM)).toEqual({
      start: { kind: "latest", count: 500 },
      select: { kind: "newest", count: 500 },
      maxEvents: 500,
    });
    expect(describeRequest(buildRequest(DEFAULT_READ_FORM) as never)).toBe(
      "the newest 500 records across the topic",
    );
  });

  it("reads the oldest records across the topic, and cannot listen after them", () => {
    const oldest = form({ mode: "oldest", count: "200", follow: true });
    expect(canFollow(oldest)).toBe(false);
    expect(buildRequest(oldest)).toEqual({
      start: { kind: "earliest" },
      select: { kind: "oldest", count: 200 },
      maxEvents: 200,
    });
  });

  it("listens after the newest, counting everything it adds against the limit", () => {
    const listening = form({ follow: true, maxEvents: "20000" });
    expect(usesEventLimit(listening)).toBe(true);
    expect(buildRequest(listening)).toMatchObject({
      select: { kind: "newest", count: 500 },
      maxEvents: 20_000,
      follow: true,
    });
  });

  it("reads a time range, and a range that ends before now does not listen", () => {
    const range = form({
      mode: "time",
      from: "2026-09-24T10:00",
      until: "2026-09-24T11:00",
      follow: true,
    });
    const request = buildRequest(range);
    expect(canFollow(range)).toBe(false);
    expect(request).toMatchObject({
      start: { kind: "timestamp" },
      end: { kind: "timestamp" },
    });
    expect((request as { follow?: boolean }).follow).toBeUndefined();
    expect(
      buildRequest(form({ mode: "time", from: "2026-09-24T11:00", until: "2026-09-24T10:00" })),
    ).toMatch(/after the start/);
    expect(buildRequest(form({ mode: "time" }))).toMatch(/choose a date and time/);
  });

  it("reads from an offset in every partition, or from one per partition", () => {
    expect(
      buildRequest(form({ mode: "offset", fromOffset: "120", untilOffset: "200" })),
    ).toMatchObject({
      start: { kind: "offset", offset: 120 },
      end: { kind: "offset", offset: 200 },
    });
    expect(buildRequest(form({ mode: "offset", fromOffset: "0:120, 2:40" }))).toMatchObject({
      start: {
        kind: "offsets",
        offsets: [
          { partition: 0, offset: 120 },
          { partition: 2, offset: 40 },
        ],
      },
    });
    expect(buildRequest(form({ mode: "offset", fromOffset: "0:120", partitions: "1" }))).toMatch(
      /not both/,
    );
    expect(buildRequest(form({ mode: "offset", fromOffset: "abc" }))).toMatch(/one offset/);
  });

  it("carries a filter, trimmed, and leaves an empty one out", () => {
    const filtered = buildRequest(
      form({
        mode: "everything",
        eventNamePrefix: " auth. ",
        application: "",
        contains: "user-42",
      }),
    );
    expect(filtered).toMatchObject({ filter: { eventNamePrefix: "auth.", contains: "user-42" } });
    expect(
      (buildRequest(form({ mode: "everything" })) as { filter?: unknown }).filter,
    ).toBeUndefined();
    expect(describeFilter({ eventNamePrefix: "auth.", contains: "user-42" })).toBe(
      'event name starts with "auth.", and the record contains "user-42"',
    );
  });

  it("refuses counts and limits outside the ceiling", () => {
    expect(buildRequest(form({ count: "0" }))).toMatch(/number of records/);
    expect(buildRequest(form({ count: "100001" }))).toMatch(/number of records/);
    expect(buildRequest(form({ mode: "everything", maxEvents: "0" }))).toMatch(/event limit/);
    expect(buildRequest(form({ count: "1.000" }))).toMatchObject({ maxEvents: 1000 });
  });

  it("reads offsets one for all, or one per partition, and nothing else", () => {
    expect(parseOffsets("42")).toBe(42);
    expect(parseOffsets("1:5 3:7")).toEqual([
      { partition: 1, offset: 5 },
      { partition: 3, offset: 7 },
    ]);
    expect(parseOffsets("1:5, 1:6")).toBe("invalid");
    expect(parseOffsets("")).toBe("invalid");
    expect(parseOffsets("-1")).toBe("invalid");
  });
});

describe("a read, as the webview hears it", () => {
  const source = {
    id: "s1",
    name: "Demo",
    bootstrapServers: ["localhost:9092"],
    topic: "audit.demo",
    security: "plaintext" as const,
  };
  const record = (offset: number) => ({
    partition: 0,
    offset,
    payload: JSON.stringify(event(`018f1b70-2c18-7f3a-b46d-${String(offset).padStart(12, "0")}`)),
  });
  const partitions = [
    { partition: 0, startOffset: 0, endOffset: 2, lowOffset: 0, records: 2, complete: true },
  ];

  async function settle(): Promise<void> {
    await new Promise((done) => setTimeout(done, 0));
  }

  it("hands a listening window over at caught-up, then new rows with a summary that counts them", async () => {
    vi.useFakeTimers();
    try {
      const { readWindow } = await import("../kafka");
      const outcome = readWindow(
        source,
        { start: { kind: "earliest" }, maxEvents: 100, follow: true },
        () => undefined,
      );
      const channel = tauri.channel();
      channel?.onmessage({ kind: "records", records: [record(0), record(1)] });
      channel?.onmessage({ kind: "caught-up", partitions });
      const { events, live, summary } = await outcome;
      expect(events).toHaveLength(2);
      expect(summary.window?.stop).toBe("listening");
      expect(summary.window?.listened).toBe(true);

      const handed: { rows: number; records: number | undefined }[] = [];
      const ends: (string | undefined)[] = [];
      live?.subscribe(
        (rows, current) => handed.push({ rows: rows.length, records: current.window?.records }),
        (final) => ends.push(final.window?.stop),
      );
      channel?.onmessage({ kind: "records", records: [record(2)] });
      channel?.onmessage({ kind: "records", records: [record(3)] });
      expect(handed).toEqual([]);
      vi.advanceTimersByTime(1000);
      expect(handed).toEqual([{ rows: 2, records: 4 }]);

      // Stopped by hand: the window was read whole, so nothing says it was cut short.
      tauri.answer()?.resolve({
        source,
        report: {
          topic: "audit.demo",
          partitions,
          scanned: 4,
          records: 4,
          followed: 2,
          bytes: 100,
          caughtUp: true,
          stop: "cancelled",
        },
        maxEvents: 100,
      });
      await vi.runAllTimersAsync();
      expect(ends).toEqual(["cancelled"]);

      // Nothing arrives after the end.
      channel?.onmessage({ kind: "records", records: [record(4)] });
      vi.advanceTimersByTime(2000);
      expect(handed).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("says listening ended by hand is no warning, and what ended it otherwise", () => {
    const listened = (stop: "cancelled" | "event-limit" | "timed-out") =>
      windowSummary(
        source,
        { start: { kind: "earliest" }, maxEvents: 100, follow: true },
        { topic: "t", partitions, scanned: 4, records: 4, followed: 2, caughtUp: true, stop },
        100,
      ).window;
    const warning = (stop: "cancelled" | "event-limit" | "timed-out") => {
      const window = listened(stop);
      return window === undefined ? "no window" : stopWarning(window);
    };
    expect(warning("cancelled")).toBeUndefined();
    expect(warning("event-limit")).toMatch(/Listening stopped at 100 events/);
    expect(warning("timed-out")).toMatch(/eight hours/);
  });

  it("ends a listening read that fails with the failure, not as still listening", async () => {
    const { readWindow } = await import("../kafka");
    const outcome = readWindow(
      source,
      { start: { kind: "earliest" }, maxEvents: 100, follow: true },
      () => undefined,
    );
    const channel = tauri.channel();
    channel?.onmessage({ kind: "caught-up", partitions });
    const { live } = await outcome;
    const ends: (string | undefined)[] = [];
    live?.subscribe(
      () => undefined,
      (final) => ends.push(`${final.window?.stop}: ${final.window?.error}`),
    );
    tauri.answer()?.reject("the broker went away");
    await settle();
    expect(ends).toEqual(["failed: the broker went away"]);
  });
});

describe("numbers as typed", () => {
  const form = (count: string): ReadForm => ({ ...DEFAULT_READ_FORM, count });
  it("reads grouped thousands, and refuses what is not a whole number", () => {
    expect(buildRequest(form("1,000"))).toMatchObject({ maxEvents: 1000 });
    expect(buildRequest(form("100.000"))).toMatchObject({ maxEvents: 100_000 });
    expect(buildRequest(form("1.5"))).toMatch(/number of records/);
    expect(buildRequest(form("1,00"))).toMatch(/number of records/);
    expect(buildRequest(form("1,000.000"))).toMatch(/number of records/);
    expect(
      buildRequest({ ...DEFAULT_READ_FORM, mode: "offset", fromOffset: "5", untilOffset: "1.5" }),
    ).toMatch(/end offset/);
  });
});
