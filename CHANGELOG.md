# Changelog

## [0.1.0] - 2026-10-13

### Added

- `compact_context` tool: the model requests compaction and it runs at the end of the current turn.
- `[context]` usage notice appended every 5 top-level tool calls (hidden, persisted, tail-append so
  the prompt-cache prefix stays intact).
- Compaction policy in the system prompt through the tool's `promptGuidelines`.
- Automatic resume on the compacted context. Failed or cancelled compaction resumes too.
