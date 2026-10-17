# Contract change: mark OTCP specification 1.0.0-rc.3 as released

- Date: 2026-10-17
- Frozen surface: `spec/otcp/v1/CHANGELOG.md` (documentation only)
- Specification version: unchanged (`1.0.0-rc.3`, wire version `1.0`). The tag `spec-v1.0.0-rc.3` exists as of 2026-10-17.

## Background

The changelog headed the `1.0.0-rc.3` section "unreleased" while the release candidate was being prepared. Now that the release candidate is tagged, the heading carries the release date.

## Changes

| File                        | Change                                                                  |
| --------------------------- | ----------------------------------------------------------------------- |
| `spec/otcp/v1/CHANGELOG.md` | Heading of the `1.0.0-rc.3` section: `unreleased` becomes `2026-10-17`. |

No schema, vector, method or PROTOCOL.md text changes.

## Compatibility

None needed: no wire format, schema or vector changes, so old and new clients and servers interoperate exactly as before.
