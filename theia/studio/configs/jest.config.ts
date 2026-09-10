import type { Config } from '@jest/types';

export default async (): Promise<Config.InitialOptions> => ({
    preset: 'ts-jest',
    testMatch: ['**.test.ts', '**.test.tsx'],
    rootDir: '../',
    transform: {
        '^.+\\.(ts|tsx)$': 'ts-jest',
    },
    testEnvironment: 'jsdom',
    setupFiles: ['<rootDir>/configs/jest-setup.js'],
    // Places the CFS-generated map schema when a checkout has none; see the
    // file for why eight suites depend on it existing.
    globalSetup: '<rootDir>/configs/jest-global-setup.js',
    // jest resolves to the ESM variant of these packages, breaking the tests
    // by forcing the resolve via Node, the commonjs variant is used
    moduleNameMapper: {
        '^vscode-languageserver-types': require.resolve('vscode-languageserver-types'),
        '^msgpackr': require.resolve('msgpackr'),
        '\\.css$': '<rootDir>/configs/style-mock.js',
    }
});
