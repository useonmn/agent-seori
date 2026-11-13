# Third-party notices

seori includes or adapts material from the projects below.

## dori-superagent

- Source: https://github.com/sisyphuslabs/dori-superagent
- Use: harness design (lead, lanes, duty loop, hourly loop, review and merge gate) and portions of code and prompts adapted for omp.
- License: MIT for upstream code up to and including commit ba96abf (that commit and its ancestors). Code first introduced upstream after ba96abf is under the Sustainable Use License; the files that contain such code are listed in the next section.

```
MIT License

Copyright (c) 2026 YeonGyu Kim

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Sustainable Use License portions

These files contain portions of dori-superagent code licensed under the Sustainable Use License (https://github.com/sisyphuslabs/dori-superagent/blob/main/LICENSE):

- .github/workflows/ci.yml
- src/adopt-sync.ts
- src/boot-checks.ts
- src/cli.ts
- src/messenger/presence.ts
- src/refs.ts
- src/runtime/hc/deliver.ts
- src/runtime/hc/exec.ts
- src/runtime/hc/index.ts
- src/runtime/hc/probe.ts
- src/runtime/hc/sessions.ts
- src/runtime/select.ts
- src/store.ts
- src/target.ts
- test/adopt-sync.test.ts
- test/boot-drift.test.ts
- test/e2e-hc-cli.test.ts
- test/e2e-hc-setup.ts
- test/e2e-hc.test.ts
- test/fixtures/fake-omp.ts
- test/helpers/fake-hc.ts
- test/helpers/hc-rig.ts
- test/messenger-presence.test.ts
- test/records-upgrade.test.ts
- test/runtime-select.test.ts
- test/resolve-target.test.ts
- test/runtime-hc-deliver.test.ts
- test/runtime-hc-misc.test.ts
- test/runtime-hc.test.ts
