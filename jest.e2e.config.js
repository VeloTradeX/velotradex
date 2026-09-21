module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/e2e/**/*.Test.ts'],
  testTimeout: 180_000,   // 3 min — covers full TP/SL wait
  maxWorkers: 1,           // sequential — tests share the same testnet account
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  collectCoverageFrom: [],
  clearMocks: false,
  restoreMocks: false,
  globalSetup: '<rootDir>/tests/e2e/globalSetup.ts',
};
