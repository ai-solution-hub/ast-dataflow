export class Service {
  doThing(): number {
    return 42;
  }
}

export function makeSvc(): Service {
  return new Service();
}
