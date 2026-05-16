// The type under test. Consumers reference its `prop` property in different ways.
export interface TargetType {
  prop: string;
  other: number;
}
