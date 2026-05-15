import { MY_CONSTANT } from './target';

// MY_CONSTANT used as a read in a runtime context — kind: 'read'
function printConstant(): void {
  console.log(MY_CONSTANT);
}

export { printConstant };
