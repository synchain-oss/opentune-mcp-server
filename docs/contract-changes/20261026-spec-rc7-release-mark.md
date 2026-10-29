# Contract change: date the 1.0.0-rc.7 section of the OTCP changelog

- Date: 2026-10-26
- Frozen surface: `spec/otcp/v1/CHANGELOG.md` (documentation only)
- Specification version: unchanged (`1.0.0-rc.7`, wire version `1.0`). The tag `spec-v1.0.0-rc.7` does not exist yet;
  the maintainers set it after this change is merged.

## Background

The changelog headed the `1.0.0-rc.7` section "unreleased" while the release candidate was being prepared. The text of
the release candidate is finalized with this change, so the heading carries the date of finalization. The status lines
of `README.md` and `PROTOCOL.md` keep the word "draft", as they did when `1.0.0-rc.6` was tagged.

## Changes

| File                        | Change                                                                  |
| --------------------------- | ----------------------------------------------------------------------- |
| `spec/otcp/v1/CHANGELOG.md` | Heading of the `1.0.0-rc.7` section: `unreleased` becomes `2026-10-26`. |

No schema, vector, method or PROTOCOL.md text changes.

## Compatibility

None needed: no wire format, schema or vector changes, so old and new clients and servers interoperate exactly as before.
