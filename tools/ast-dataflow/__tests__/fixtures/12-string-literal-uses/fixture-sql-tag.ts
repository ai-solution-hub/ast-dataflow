/**
 * Fixture: SQL tagged template literal site.
 *
 * string-literal-uses --value 'SELECT * FROM projects' must return
 * this file with kind 'sqlTag' for the content inside the sql`` template.
 *
 * Note: ts-morph sees tagged template literals as TemplateExpression nodes.
 * The literal head/tail of a NoSubstitutionTemplateLiteral contains the text.
 * This fixture uses a no-substitution template literal so the full text is
 * available as the literal value.
 */

declare function sql(strings: TemplateStringsArray): string;

// The target literal: 'SELECT * FROM projects'
export const query = sql`SELECT * FROM projects`;

// A different sql tag — must NOT match 'SELECT * FROM projects'
export const otherQuery = sql`SELECT id FROM users`;
