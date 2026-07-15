// Fixture: re-assignment into an existing binding — pre-fix the flow was
// silently dropped (no row at all for `out = data`).
export function reassignFlow(): void {
  const data = { id: 1 }; // flow-trace origin
  let out: unknown = null;
  out = data; // must emit an assignment hop
  sink(out); // and the walk continues: argument hop via `out`
}

function sink(_v: unknown): void {}
