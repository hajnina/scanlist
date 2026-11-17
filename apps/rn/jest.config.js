module.exports = {
  preset: '@react-native/jest-preset',
  setupFiles: ['<rootDir>/jest.setup.js'],
  // Card A2: `@scanlist/ts-core` is a source-only package at ../../shared/ts-core (see
  // metro.config.js). Jest resolves the bare specifier to its TypeScript entry point; the file is
  // outside rootDir but still transformed by babel-jest with the app's preset. That preset emits
  // `@babel/runtime` helper imports, which must resolve from THIS project's node_modules even for a
  // file living outside rootDir — hence `modulePaths` (Metro does the same via nodeModulesPaths).
  moduleNameMapper: {
    '^@scanlist/ts-core$': '<rootDir>/../../shared/ts-core/src/index.ts',
  },
  modulePaths: ['<rootDir>/node_modules'],
};
