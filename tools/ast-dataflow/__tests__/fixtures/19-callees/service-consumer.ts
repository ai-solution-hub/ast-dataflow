import { Service, makeSvc } from './service';

export function usesService(): number {
  const svcTyped: Service = new Service();
  svcTyped.doThing();
  const s = makeSvc();
  s.doThing();
  return makeSvc().doThing();
}
