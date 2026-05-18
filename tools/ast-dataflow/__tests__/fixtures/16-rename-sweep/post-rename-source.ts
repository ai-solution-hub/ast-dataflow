/**
 * Fixture: post-rename source module.
 *
 * Simulates lib/reports/generate-change-report.ts after a rename.
 * The function was renamed from generateReport → generateChangeReport.
 * gitnexus_rename applied the TypeScript symbol rename automatically.
 *
 * The rename-sweep verifier checks:
 *   Q1 string-literal-uses: are there string literals still referencing
 *      the OLD name 'generateReport' or old module path '@/lib/reports/generate-report'?
 *   Q2 importers: does any file still import the OLD module path?
 *   Q3 references: do all TS-symbol references now point to generateChangeReport?
 */

export interface ChangeReport {
  id: string;
  title: string;
  generatedAt: Date;
}

export async function generateChangeReport(title: string): Promise<ChangeReport> {
  return {
    id: crypto.randomUUID(),
    title,
    generatedAt: new Date(),
  };
}

export type { ChangeReport as Report };
