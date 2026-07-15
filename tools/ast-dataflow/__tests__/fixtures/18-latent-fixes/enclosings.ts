// Fixture: enclosing-scope shapes findEnclosing previously misreported.
export function target(): number {
  return 1;
}

export class Widget {
  size: number;

  constructor() {
    this.size = target(); // enclosing must be method:Widget.constructor
  }

  get area(): number {
    return target(); // enclosing must be method:Widget.area
  }

  static registry: number[] = [];

  static {
    Widget.registry.push(target()); // enclosing must be method:Widget.<static>
  }
}

export function hostFunction(): { handler: number } {
  // Non-function property value — enclosing must be fn:hostFunction,
  // NOT method:cfg.handler.
  const cfg = { handler: target() };
  return cfg;
}

// Function-valued property — enclosing must be method:handlers.onPing.
export const handlers = {
  onPing: () => target(),
};

// `as const` wrapper — container name must resolve through the AsExpression.
export const frozen = {
  compute: () => target(),
} as const;
