// This file IS the target for the write-kind test.
// The symbol 'writableState' is declared here (mutable) and written to
// within this same file. The references query on 'writableState' should
// classify the assignment on the LHS as kind: 'write'.
export let writableState = 0;

// This line references writableState on the LHS of a BinaryExpression —
// the classifier should tag this as kind: 'write'.
writableState += 1;
