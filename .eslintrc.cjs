module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
  ],
  env: {
    node: true,
    es2021: true,
  },
  parserOptions: {
    ecmaVersion: 'latest',
    sourceType: 'module',
  },
  ignorePatterns: [
    'node_modules/',
    'dist/',
    'coverage/',
    'tests/e2e/',
    'admin-web/',
    'tools/lighter-signer/',
    '**/*.d.ts',
  ],
  rules: {
    // 存量代码大量使用 any，本阶段不清理，仅提示不拦截
    '@typescript-eslint/no-explicit-any': 'off',
    'no-explicit-any': 'off',
    'no-empty': 'warn',
    // 与存量代码风格兼容的宽松调整，避免大规模误报
    '@typescript-eslint/no-unused-vars': 'warn',
    '@typescript-eslint/no-var-requires': 'warn',
  },
};