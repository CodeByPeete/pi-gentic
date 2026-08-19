# Track the current Pi host directly

Pi-gentic uses Pi's public extension and session features wherever they preserve the required behavior. Private host integration lives under `src/pi/`. Only `src/pi/runtime.ts` loads files from the installed Pi implementation.

The package targets the current Pi release only. Version `0.4.0` currently depends on Pi `0.84.2`, which is the latest published release. All Pi packages move together when Pi is updated. The codebase keeps one host implementation in place, with no older-version adapter, migration path, or runtime version dispatch.

Startup validates the capabilities pi-gentic needs and reports missing host operations clearly. Host contract, session transition, resume, integration, terminal, and UI tests must pass against every Pi update.

Private integration can be removed as Pi exposes equivalent public operations. Until then, the direct host modules preserve native Pi commands, input handling, sessions, and rendering.
