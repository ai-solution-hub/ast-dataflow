// Fixture: shadowed binding — the inner `data` must NOT appear as a hop of
// the outer `data` trace (pre-fix text matching walked into nested scopes).
export function outer(): void {
  const data = { id: 1 }; // flow-trace origin: the `data` declaration

  function inner(): void {
    const data = { id: 2 }; // shadow — unrelated binding
    consume(data); // must NOT be a hop of outer `data`
  }

  inner();
  const copy = data; // legit assignment hop of outer `data`
  consume(copy);
}

function consume(_v: unknown): void {}
