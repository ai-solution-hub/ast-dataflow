/**
 * Fixture: correctly-renamed consumer.
 *
 * This file was updated by gitnexus_rename — it now imports
 * generateChangeReport from the new module path. It represents the
 * "clean" callers that gitnexus handled with high-confidence graph edits.
 *
 * The rename-sweep verifier should find NO unmissed sites here.
 */

import { generateChangeReport } from './post-rename-source';

export async function buildWeeklyReport(): Promise<void> {
  const report = await generateChangeReport('Weekly summary');
  console.log(`Report generated: ${report.id}`);
}
