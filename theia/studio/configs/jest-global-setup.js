// Put the CFS map schema where the code expects it, once, before the suites run.
//
// src/node/cfs-map-adapter.ts `require`s ../../../.cf-studio/.core/schemas/
// map.schema.json at load time. Constructor Studio generates that file and it is
// gitignored, so in a fresh checkout eight suites cannot even load —
// "Cannot find module …/map.schema.json" — which reads like a broken test and is
// a missing generated artifact. docker/cfs-map.schema.json is the canonical copy
// the session image installs at exactly that path (see theia/Dockerfile), so the
// same copy is placed here.
//
// Only when the file is absent. On a machine where CFS has generated the real
// one, that one stays — which is what keeps the parity test in
// cfs-map-adapter.test.ts meaningful: it then compares two independently
// produced files instead of a copy with itself.
const fs = require('fs');
const path = require('path');

module.exports = async () => {
    const runtime = path.resolve(__dirname, '../../.cf-studio/.core/schemas/map.schema.json');
    if (fs.existsSync(runtime)) {
        return;
    }
    fs.mkdirSync(path.dirname(runtime), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, '../../docker/cfs-map.schema.json'), runtime);
};
