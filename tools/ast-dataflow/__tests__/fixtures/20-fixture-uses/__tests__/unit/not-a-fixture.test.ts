import { describe, expect, it } from 'vitest';

// Deliberately named *.test.ts inside the fixture corpus: fixture-uses'
// convention gate (D1: /fixtures/ segment OR *-fixture.ts basename) must NOT
// scan this file even though it contains the needle. Vitest still collects it
// (tools/**/*.test.ts), so it doubles as a trivially passing suite member.
describe('20-fixture-uses corpus — not-a-fixture guard file', () => {
  it("holds the 'project_id' needle without being part of the fixture scan", () => {
    expect('project_id').toHaveLength(10);
  });
});
