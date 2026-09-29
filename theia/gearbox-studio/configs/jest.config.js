// Unit tests for the rules that decide, not for the widgets that draw them:
// which folders hold products, which source a new product declares, where a
// git source is brought. Node by default -- none of them touch a document; a
// suite that does says `@jest-environment jsdom`.
/** @type {import('jest').Config} */
module.exports = {
  rootDir: "../",
  testMatch: ["<rootDir>/src/**/*.test.ts", "<rootDir>/src/**/*.test.tsx"],
  testEnvironment: "node",
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.json" }],
  },
  // jest resolves the ESM builds of these under jsdom; the commonjs ones are
  // what Node loads (the same mapping theia/studio's config carries).
  moduleNameMapper: {
    "^vscode-languageserver-types": require.resolve("vscode-languageserver-types"),
    "^msgpackr": require.resolve("msgpackr"),
    "\\.css$": "<rootDir>/configs/style-mock.js",
  },
};
