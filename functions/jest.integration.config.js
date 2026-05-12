// Integration test config（Firestore Emulator 必要）
//
// 実行：
//   1. emulator 起動：
//      $ export PATH="/opt/homebrew/opt/openjdk/bin:$PATH"
//      $ firebase emulators:start --only firestore --project futami-yoyaku-492607
//   2. 別ターミナルで：
//      $ cd functions && npm run test:integration
//
// 注意：--runInBand で順次実行（並列だと Firestore 状態が混ざる）

module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/tests/integration'],
  testMatch: ['**/*.integration.test.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/lib/'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  // 順次実行（並列 NG）
  maxWorkers: 1,
};
