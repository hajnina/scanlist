const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * Card A2: `@scanlist/ts-core` (`shared/ts-core/`, merged in card S8) is a source-only ESM package
 * that lives OUTSIDE this project root, so Metro does not watch it by default. `watchFolders`
 * lets the bundler read it and `extraNodeModules` maps the bare specifier to the package directory
 * (its package.json `exports`/`main` point at `src/index.ts`, so no build step is involved).
 * The same mapping is repeated in `tsconfig.json` (`paths`, for `tsc --noEmit`) and
 * `jest.config.js` (`moduleNameMapper`, for the unit tests) — one mechanism per tool, no copy of
 * the shared code inside the app.
 *
 * @type {import('@react-native/metro-config').MetroConfig}
 */
const tsCoreDir = path.resolve(__dirname, '../../shared/ts-core');

const config = {
  watchFolders: [tsCoreDir],
  resolver: {
    extraNodeModules: {
      '@scanlist/ts-core': tsCoreDir,
    },
    // Babel's runtime helpers are imported from the ts-core files (bare `@babel/runtime/...`
    // specifiers). Metro looks them up next to the importing file by default, and ts-core lives
    // outside this project root, so list this project's node_modules as a search root.
    nodeModulesPaths: [path.resolve(__dirname, 'node_modules')],
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
