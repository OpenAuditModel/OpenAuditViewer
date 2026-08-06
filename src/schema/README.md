# Vendored schema

`audit-event.schema.json` is a copy of `schemas/v0.1/audit-event.schema.json` from
[OpenAuditModel](https://github.com/OpenAuditModel/OpenAuditModel) (spec version 0.1, `$id`
`https://openauditmodel.org/schemas/audit-event/0.1/schema.json`).

It is vendored rather than taken from `@openauditmodel/cli` at runtime because that package assumes
a Node runtime (`node:fs`, `node:crypto`) which a Tauri webview does not provide, and because the
app must work with no network access.

Refresh it, along with the profile definitions in `src/profiles/`, with:

```bash
npm run sync-vendored -- ../path/to/OpenAuditModel
```

The script reports what changed and regenerates the precompiled validator. Nothing detects drift
automatically, so a schema change upstream is invisible here until someone runs it.

`validate.generated.js` is produced from this schema by `tools/generate-validator.mjs` and is
committed. Do not edit it by hand — CI regenerates it and fails if the committed copy differs.
