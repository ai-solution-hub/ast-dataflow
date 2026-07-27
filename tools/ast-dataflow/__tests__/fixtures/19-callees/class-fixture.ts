function local(): number {
  return 0;
}

export class Base {
  m(): number {
    return local();
  }
}

export class Sub extends Base {
  m(): number {
    super.m();
    this.own();
    return 2;
  }

  own(): number {
    return local();
  }
}
