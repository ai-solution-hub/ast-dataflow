/**
 * Fixture: JSX prop value site.
 *
 * string-literal-uses --value 'https://example.com/page' must return
 * this file with kind 'jsxProp' for the href attribute value.
 *
 * The second href 'https://other.com' must NOT appear in results.
 */

import React from 'react';

export function NavLink() {
  return (
    <div>
      <a href="https://example.com/page">Main link</a>
      <a href="https://other.com">Other link</a>
    </div>
  );
}
