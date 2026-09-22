// A frame package, not a module: no federation plugin, no exposed module, no
// remote entry. `vite build` emits index.html into dist/, package-mfe-assets
// copies it beside every other remote, and the shell only ever learns its
// address. See docs/adr/0021-an-mfe-entry-may-be-a-frame.md.
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    target: 'esnext',
  },
});
