// eslint-disable-next-line @typescript-eslint/no-unused-vars -- fixture intent: property keys/accesses named like the import must not count as usage
import { helper } from './target2.js';

const settings = { helper: 'local-value' };

export function readSetting(): string {
  return settings.helper;
}
