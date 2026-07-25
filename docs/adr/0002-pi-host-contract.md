# Use an upstream-first Pi host contract

Pi-gentic integrates through versioned public Pi capabilities and confines the existing Pi 0.82 private bridge to an exact-version legacy adapter until the public host contract covers every behavior. This preserves live session capabilities during migration while preventing undocumented host details from spreading through application code.

The adapter's deletion target is the first pi-gentic release that requires Pi 0.83.0 or later, provided the public host contract passes the same compatibility suite. Until that gate passes, package peers remain pinned to Pi 0.82.0.
