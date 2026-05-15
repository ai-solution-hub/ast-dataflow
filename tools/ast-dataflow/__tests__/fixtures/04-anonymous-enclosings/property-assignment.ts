import { target } from './target';

// Case 1: object-literal PropertyAssignment with a method shorthand.
// The object is assigned to a named const, so the container is 'myService'.
// expected: method:myService.doWork
export const myService = {
  doWork() {
    return target();
  },
};

// Case 2: PropertyAssignment with arrow-function value.
// expected: method:anotherService.transform
export const anotherService = {
  transform: () => {
    return target();
  },
};
