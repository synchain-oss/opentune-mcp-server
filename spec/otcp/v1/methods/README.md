# Method schema files

Every OTCP method has one file in this directory, `<method>.schema.json` (for example `job.get.schema.json`). `index.json` lists every method of protocol major 1, including those whose file is not written yet. The shape of a method file is defined by `../schemas/method-file.schema.json`.

## Format

A method file is a JSON Schema 2020-12 document:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://otcp.invalid/v1/methods/job.get.schema.json",
  "title": "job.get",
  "description": "What the method does, in one paragraph.",
  "x-otcp": {
    "method": "job.get",
    "layer": "L3",
    "capability": "jobs.v1",
    "since": "1.0",
    "write": "no",
    "resultKind": "plain",
    "startsJob": null,
    "requiresSession": true,
    "errors": [
      "INVALID_ARGUMENT",
      "NOT_FOUND",
      "BUSY",
      "SHUTTING_DOWN",
      "INTERNAL"
    ]
  },
  "$defs": {
    "params": { "type": "object" },
    "result": { "type": "object" }
  }
}
```

| Member                   | Rule                                                                                                                                                                                                                          |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `$id`                    | `https://otcp.invalid/v1/methods/<method>.schema.json`. The `otcp.invalid` host is an identifier, not a download location (the `.invalid` top-level domain never resolves); tools map it to this directory.                   |
| `title`                  | The method name. Equal to `x-otcp.method` and to the file name without `.schema.json`.                                                                                                                                        |
| `description`            | What the method does, with references to the PROTOCOL.md sections that govern it.                                                                                                                                             |
| `x-otcp.method`          | Method name, `<namespace>.<name>`.                                                                                                                                                                                            |
| `x-otcp.layer`           | `L2` to `L8` (PROTOCOL.md section 22).                                                                                                                                                                                        |
| `x-otcp.capability`      | Capability from `../registry/capabilities.json` that the method needs.                                                                                                                                                        |
| `x-otcp.since`           | Protocol version (`MAJOR.MINOR`) that introduced the method.                                                                                                                                                                  |
| `x-otcp.write`           | `yes`, `no` or `conditional` (PROTOCOL.md section 22).                                                                                                                                                                        |
| `x-otcp.resultKind`      | `write` (the result extends the write envelope, PROTOCOL.md section 14), `read` (the result carries `asOf` and `derived`, section 16) or `plain`.                                                                             |
| `x-otcp.startsJob`       | Job kind the method may start, or null.                                                                                                                                                                                       |
| `x-otcp.requiresSession` | false only for `session.hello`.                                                                                                                                                                                               |
| `x-otcp.errors`          | Every error kind the method may return, including generic ones such as `INVALID_ARGUMENT`, `BUSY`, `SHUTTING_DOWN` and `INTERNAL`. Kinds come from `../registry/error-kinds.json`.                                            |
| `$defs.params`           | Schema of `params`. Closed: unknown members are invalid (PROTOCOL.md section 2.3). A method without params has an empty, closed object.                                                                                       |
| `$defs.result`           | Schema of `result`. A `write` result composes `../schemas/common.schema.json#/$defs/writeEnvelope` with `allOf` and closes itself with `unevaluatedProperties: false`; a `read` result does the same with `#/$defs/readMeta`. |

Shared types are referenced as `../schemas/common.schema.json#/$defs/<name>`. Other documents refer to a method's schemas as `<method>.schema.json#/$defs/params` and `#/$defs/result`.

`x-otcp` is an annotation keyword. Validators that reject unknown keywords (for example Ajv in strict mode) need it registered, for instance with `ajv.addKeyword({ keyword: "x-otcp" })`; its content is validated against `../schemas/method-file.schema.json`.

## Rules

1. Adding a method file, or a member to one, follows the versioning rules of PROTOCOL.md section 2.2. A method file is never deleted or renamed within a major version.
2. `index.json` and the table in PROTOCOL.md section 22 list the same methods with the same layer, capability, write classification, `since` and schema status; a method file exists exactly for the methods marked `defined`.
3. Every method file has at least one success vector in `../vectors/`.
4. Codes used in descriptions (error kinds, reasons, warnings) come from `../registry/`.
