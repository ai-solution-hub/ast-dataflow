import { Widget } from './target2.js';

// The only usage is a JSX tag name — must count as a real use.
export function App(): unknown {
  return <Widget />;
}
