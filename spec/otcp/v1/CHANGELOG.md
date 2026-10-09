# Changelog

All notable changes to the OTCP specification are recorded here. Versions follow `MAJOR.MINOR.PATCH` (README.md, "Versions"); each released version is tagged `spec-v<version>`.

## [1.0.0-rc.1] - unreleased

First release candidate of protocol major 1. Work in progress: the entries below are in place; the remaining schemas and vectors of this release candidate are listed under "Pending".

### Added

- PROTOCOL.md: conventions; scope and non-goals; versioning and compatibility rules; transport and framing (literal `127.0.0.1`, OS-assigned port, one JSON message per line, a JSON-RPC 2.0 profile without batches or server-initiated messages); limits; rules before authentication; `session.hello` with fixed failure responses and server-proof verification; discovery files and their lifecycle; enabling the control API; capabilities and registries; clocks and unit suffixes; handles; revision tokens; the readiness gate; jobs and cancellation per job kind; concurrency, busy checks and UI priority; the write result envelope; undo descriptors, revert recipes and undo rules; read conventions; errors; warnings; the export contract; paths and untrusted strings; editing schemes; the layer table and the index of all 43 methods.
- SECURITY.md: threat model with mitigations and residual risks.
- Registries: 19 error kinds, reason codes, 26 warning codes, 17 capabilities.
- Schemas: shared types, discovery file and ready file, registry files, method files, test vectors.
- Method schemas: `session.hello`, `session.info`, `job.get`, `job.cancel`.
- Vectors for the session layer (authentication, version negotiation, repeated hello, first-line rules, batches, unknown params) and for jobs.

### Pending

- Method schemas and vectors for `project.get`, `content.getNotes`, `content.getPitchCurve`, `content.segmentNotes`, `content.getDetails`, `transport.get`, `prefs.get`, `app.getLog`, `import.start`, `export.start`, `content.setKey`, `content.autoTune`, `content.editNotes`, `content.setPitchShift`, `edit.getHistory`, `edit.undo`, `edit.redo`, `content.shiftTiming` and `content.editTimeGrid`, before the `spec-v1.0.0-rc.1` tag.
- Method schemas and vectors for the remaining methods of layers L3, L6 and L8 in a later release candidate of 1.0.0.
