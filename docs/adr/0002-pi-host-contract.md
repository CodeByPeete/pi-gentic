# Use an upstream-first Pi host contract

Pi-gentic uses Pi's public extension and session features wherever they preserve the required behavior. The remaining private integration stays inside one version-pinned adapter so undocumented Pi details do not spread through the application.

Version `0.4.0` requires Pi `0.84.2` exactly. The adapter checks both that version and the private capabilities it needs before installation. An unsupported host fails early with a compatibility message.

The adapter can be removed after Pi's public host contract covers the same live-session, session-switching, abort, prompt, and resume behavior and passes the existing compatibility suite. Until then, the package keeps its Pi peer dependencies pinned to the exact tested version.
