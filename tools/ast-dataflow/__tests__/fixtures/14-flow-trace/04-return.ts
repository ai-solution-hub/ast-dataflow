// Fixture: return propagation
// origin: const data (line 5)
// hop 2: return data — return hop; walk ends intra-function

export function getData() {
  const data = { result: 'ok' };
  return data;
}
