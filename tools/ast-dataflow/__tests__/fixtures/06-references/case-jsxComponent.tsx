import * as React from 'react';
import { MyWidget } from './component-target';

// MyWidget used as a JSX opening element tag — kind: 'jsxComponent'
function Page(): React.ReactElement {
  return <MyWidget />;
}

export { Page };
