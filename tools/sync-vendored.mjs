/**
 * Re-vendors the canonical schema and profile definitions from a local
 * checkout of the OpenAuditModel repository, and says exactly what changed.
 *
 * The viewer bundles copies of these files (src/schema/, src/profiles/) so
 * that it works fully offline; the cost is that they can silently drift from
 * the canonical repository. This script is the antidote: run it after
 * pulling the canonical repository, review the reported changes, re-run the
 * tests.
 *
 *   npm run sync-vendored -- ../path/to/OpenAuditModel
 *
 * With no argument the conventional sibling locations are tried. Only files
 * that already exist here are updated: a NEW upstream profile is reported
 * but not adopted, because adopting one also means registering it in
 * src/lib/profiles/index.ts.
 */
import { copyFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const viewerRoot = resolve(import.meta.dirname, "..");

/** Conventional checkout locations, tried in order when none is given. */
const DEFAULT_CANDIDATES = ["../OpenAuditModel", "../OpenAuditModelGit"];

function locateSource() {
  const explicit = process.argv[2];
  if (explicit !== undefined) {
    return resolve(explicit);
  }
  for (const candidate of DEFAULT_CANDIDATES) {
    const path = resolve(join(viewerRoot, candidate));
    if (existsSync(join(path, "schemas"))) {
      return path;
    }
  }
  return undefined;
}

const sourceRoot = locateSource();

if (sourceRoot === undefined || !existsSync(join(sourceRoot, "schemas"))) {
  console.error("no OpenAuditModel checkout found.");
  console.error(`looked for: ${DEFAULT_CANDIDATES.join(", ")} (relative to this repository)`);
  console.error("pass the path explicitly: npm run sync-vendored -- ../path/to/OpenAuditModel");
  process.exit(1);
}

let changed = 0;
let unchanged = 0;
let missing = 0;

function sync(sourcePath, targetPath, label) {
  if (!existsSync(sourcePath)) {
    console.log(`  MISSING upstream  ${label} (${sourcePath})`);
    missing += 1;
    return;
  }
  const source = readFileSync(sourcePath);
  const target = existsSync(targetPath) ? readFileSync(targetPath) : null;
  if (target !== null && source.equals(target)) {
    unchanged += 1;
    return;
  }
  copyFileSync(sourcePath, targetPath);
  console.log(`  UPDATED           ${label}`);
  changed += 1;
}

console.log(`syncing from ${sourceRoot}\n`);

// Highest versioned schema directory (v0.1, v0.2, ...) wins.
const schemaVersions = readdirSync(join(sourceRoot, "schemas"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && /^v\d+\.\d+$/.test(entry.name))
  .map((entry) => entry.name)
  .sort(
    (left, right) =>
      Number(left.slice(1).replace(".", "")) - Number(right.slice(1).replace(".", "")),
  );
const latestSchemaDir = schemaVersions[schemaVersions.length - 1];
if (latestSchemaDir === undefined) {
  console.error("no versioned schema directory found under schemas/");
  process.exit(1);
}
if (schemaVersions.length > 1) {
  console.log(
    `  note: multiple schema versions upstream (${schemaVersions.join(", ")}), syncing ${latestSchemaDir}`,
  );
}
sync(
  join(sourceRoot, "schemas", latestSchemaDir, "audit-event.schema.json"),
  join(viewerRoot, "src", "schema", "audit-event.schema.json"),
  `schema/audit-event.schema.json (${latestSchemaDir})`,
);

const profilesDir = join(viewerRoot, "src", "profiles");
for (const file of readdirSync(profilesDir).filter((name) => name.endsWith(".json"))) {
  const profileName = file.replace(/\.json$/, "");
  sync(
    join(sourceRoot, "profiles", profileName, "profile.json"),
    join(profilesDir, file),
    `profiles/${file}`,
  );
}

// New upstream profiles are reported, not adopted: registration in
// src/lib/profiles/index.ts is a deliberate step, not a side effect.
const upstreamProfiles = readdirSync(join(sourceRoot, "profiles"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => existsSync(join(sourceRoot, "profiles", name, "profile.json")));
const vendored = new Set(
  readdirSync(profilesDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => name.replace(/\.json$/, "")),
);
for (const name of upstreamProfiles) {
  if (!vendored.has(name)) {
    console.log(
      `  NEW upstream      profiles/${name} — vendor it and register in src/lib/profiles/index.ts`,
    );
  }
}

console.log(
  `\n${changed} updated, ${unchanged} unchanged${missing > 0 ? `, ${missing} missing upstream` : ""}`,
);
if (changed > 0) {
  console.log("run `npm test` and `npx tsc --noEmit` before committing the refresh.");
}
