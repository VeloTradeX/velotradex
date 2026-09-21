/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[jt]sx?$': ['ts-jest', { useESM: false }],
  },
  roots: ['<rootDir>/tests'],
  testMatch: [
    '**/*.Test.ts',
    '**/*.test.ts',
  ],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  collectCoverageFrom: [
    'src/services/**/*.ts',
    '!src/services/**/*.test.ts',
    '!src/services/exchanges/*.ts',
  ],
  clearMocks: true,
  restoreMocks: true,
};
