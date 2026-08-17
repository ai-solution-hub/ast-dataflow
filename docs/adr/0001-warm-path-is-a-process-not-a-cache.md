# ADR 0001: The warm path is a long-lived process, not a persisted cache

## Context

The original product spec (private to the origin repo) assumed a "warm cache", and its
roadmap carried an LMDB per-file facts-cache design for years of sessions. Measurement
settled it: 11 of 12 queries consume the live type-checked ts-morph AST, so a per-file
extracted-facts cache would serve roughly one query while adding an invalidation surface.

## Decision

The warm path is a long-lived process — a stdio MCP server holding the ts-morph `Project`
— not a persisted index file. Per-file invalidation is `refreshFromFileSystemSync()` on
mtime+size change, and staleness is reported loudly via the `meta` envelope field. The CLI
remains the always-available cold path (the original spec's invariant 21), and both CLI
and server dispatch through a single shared `dispatch.ts` behind one `ast_dataflow` tool.

Rejected: the LMDB per-file facts cache, by the measurement above. Rejected: a shared
daemon — a client-owned per-session subprocess keeps the always-works CLI contract without
daemon lifecycle management.

## Consequences

- Warm-query latency is ~6 s on the first call (project load), then ~100–200 ms.
- A session either uses the CLI or starts the server explicitly
  (`bun run ast-dataflow-mcp`).
- Staleness is a reported condition, not a prevented one: consumers must read `meta`
  rather than assume the Project matches disk.

_(was DR-100 in the origin repo's private decision register)_
