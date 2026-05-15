import { target } from './target';

// Case: arrow-function callback passed to useEffect().
// The outer arrow function assigned to 'MyComponent' is the named host.
// Walking past the anonymous useEffect callback bubbles up to MyComponent.
// expected: fn:MyComponent
export const MyComponent = () => {
  function useEffect(_fn: () => void): void { /* stub */ }
  useEffect(() => {
    target();
  });
  return 'rendered';
};
