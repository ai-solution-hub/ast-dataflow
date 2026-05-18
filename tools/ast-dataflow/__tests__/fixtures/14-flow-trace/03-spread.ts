// Fixture: spread hop (wildcard confidence)
// origin: const payload (line 7)
// hop 2: spread { ...payload } into merged (line 8) — confidence wildcard, terminal

export function processSpread() {
  const payload = { id: 1, name: 'test' };
  const merged = { ...payload, extra: true };
  // merged uses payload via spread; identity is unresolvable
  return merged;
}
