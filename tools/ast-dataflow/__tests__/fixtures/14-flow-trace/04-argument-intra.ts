// Fixture: argument passthrough (intra-function, no descent)
// origin: const value (line 10)
// hop 2: doSomething(value) — argument hop at the call site (line 11)

function doSomething(_x: number): void {
  // callee body — not descended into with interFunction: false
}

export function processArgument() {
  const value = 42;
  doSomething(value);
}
