/**
 * Carried over from the monorepo this package was extracted from: without it,
 * any formatter run rewrites the whole tree from single to double quotes and
 * every diff becomes unreadable churn. The settings reproduce the formatting
 * the existing sources were written with.
 *
 * @type {import("prettier").Config}
 */
const config = {
  semi: true,
  singleQuote: true,
  trailingComma: 'all',
  printWidth: 80,
  tabWidth: 2,
  useTabs: false,
  bracketSpacing: true,
  arrowParens: 'always',
  quoteProps: 'as-needed',
  proseWrap: 'always',
  endOfLine: 'lf',
  overrides: [
    {
      files: '*.md',
      options: { printWidth: 90, trailingComma: 'es5' },
    },
    {
      files: '*.json',
      options: { printWidth: 120, tabWidth: 2 },
    },
    {
      files: ['*.yml', '*.yaml'],
      options: { tabWidth: 2, singleQuote: false },
    },
  ],
};
export default config;
