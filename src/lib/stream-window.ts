/**
 * Whether the events on screen are a window read from a stream rather than
 * the contents of a folder.
 *
 * It changes what a chain can be said to be: in a folder, a hole in a chain is
 * an event that is not there; in a window read from a Kafka topic, it may be
 * an event the window did not reach. See `verifyChains`' `windowed` option.
 */
import type { LoadedEvent } from "./types";

export function isStreamWindow(events: readonly LoadedEvent[]): boolean {
  return events.length > 0 && events[0]?.sourceFormat === "kafka";
}

/**
 * Where a row came from, at the grain worth grouping by: its file, or — for a
 * record read from Kafka, whose label ends in `partition@offset` — its
 * partition. A record is not a file; ranking single records as "the files
 * holding invalid events" would list every record once.
 */
export function sourceGroup(row: Pick<LoadedEvent, "sourceFile" | "sourceFormat">): string {
  if (row.sourceFormat !== "kafka") {
    return row.sourceFile;
  }
  const at = row.sourceFile.lastIndexOf("@");
  return at === -1 ? row.sourceFile : row.sourceFile.slice(0, at);
}
