/** Jest 設定（2026-05-05 新設・/gfu Phase A-2） */
// 純粋関数ユニットテストは emulator 不要・常時実行。
// integration テスト（Firestore Emulator 必要）は tests/integration/ 配下に分離し、
// `npm run test:integration` で別途実行する。
//
// emulator 起動：
//   $ export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"
//   $ firebase emulators:start --only firestore --project futami-yoyaku-492607
//
// integration 実行：
//   $ FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 npm run test:integration
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/__tests__/**/*.test.ts', '**/?(*.)+(spec|test).ts'],
  testPathIgnorePatterns: ['/node_modules/', '/lib/', '/tests/integration/'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
  ],
};
