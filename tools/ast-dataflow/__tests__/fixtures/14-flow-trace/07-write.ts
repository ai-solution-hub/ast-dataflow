// Fixture: write sink (fs.writeFile)
// origin: const content (line 8)
// hop 2: fs.writeFile(path, content) — write hop, terminal

import { promises as fs } from 'node:fs';

export async function processWrite() {
  const content = 'hello world';
  await fs.writeFile('/tmp/output.txt', content);
  // write hop emitted at fs.writeFile call
}
