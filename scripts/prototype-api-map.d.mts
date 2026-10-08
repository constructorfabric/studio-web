// Types for prototype-api-map.mjs, for the prototype's TypeScript code that
// imports it (vite.config.ts, src/architecture.test.ts).

export interface PrototypeMapScreen {
  /** The React component. */
  name: string;
  /** `src/…`, relative to the prototype. */
  file: string;
  /** Backend paths it reaches, `{}` for a variable segment. */
  paths: string[];
}

export function buildPrototypeMap(options: {
  srcDir: string;
  root?: string;
  commit?: string | null;
}): { commit: string | null; screens: PrototypeMapScreen[] };

export function prototypeSrcDir(): string;
