# Effect feature ledger

Pi-gentic uses Effect 4. The linked Effect 3 sidebar is the adoption checklist because the same architectural families exist in Effect 4. A feature may own a real pi-gentic responsibility, remain behind Pi's native capability boundary, or have an activation rule for data the host does not currently expose. Decorative imports are forbidden.

| Sidebar family | Pi-gentic responsibility |
| --- | --- |
| Getting Started | `Effect`, generators, pipelines, and control-flow operators define reusable application and infrastructure operations. `ManagedRuntime` is the only Pi callback bridge. |
| Error Management | Tagged expected errors, defects, causes, exits, typed fallback, timeout, interruption, and accumulated schema diagnostics preserve every failure channel. |
| Requirements Management | `Context.Service` contracts and `Layer` composition provide Git, worktree, registry, fiber, filesystem, path, clock, logging, and runtime capabilities. |
| Resource Management | `Scope`, `Effect.scoped`, acquire/release semantics, and managed fibers own child processes, subscriptions, timers, caches, and runtime disposal. |
| Observability | Structured Effect logs, spans, redacted attributes, Git metrics, bounded compatibility diagnostics, and runtime snapshots provide local observability without network exporters. |
| Configuration | Pi remains authoritative for settings and trust. Effect Schema decodes the trusted configuration boundary; an Effect `ConfigProvider` becomes appropriate when Pi exposes configuration as an Effect service. |
| Runtime | One `ManagedRuntime` belongs to each loaded extension host. Session replacement preserves it; quit and reload dispose it. |
| Scheduling | `Schedule.spaced` drives live repaint cadence without catch-up bursts after event-loop stalls. Effect timeouts bound Git, and retry schedules are restricted to classified transient failures. |
| State Management | `SubscriptionRef` and immutable `HashMap` model observable runtime metadata and atomic transitions. `SynchronizedRef` activates only when one atomic transition must itself execute an effect; the current transitions are pure. |
| Batching | Native Pi listing is the single source. Concurrent requests are coalesced by Effect `Cache`; large native listings run in an isolated process and metadata enrichment yields between bounded chunks. Request batching is reserved for a public Pi batch boundary. |
| Caching | Effect `Cache` owns hydrated native session lists. Fingerprints invalidate small lists, while large lists use stale-while-revalidate with immediate skeletons. |
| Concurrency | `Fiber`, `FiberMap`, `Semaphore`, interruption, and managed runtime ownership cover delegation and presentation concurrency. Queue, PubSub, Deferred, and Latch are used only where ordered backpressure, fan-out, one-shot completion, or readiness are domain requirements. |
| Stream | Scoped child-process output and live filesystem membership events use `Stream`. Native Pi agent events remain at Pi's subscription boundary until Pi exposes a pull-based stream contract. |
| Sink | Process streams fold complete output because Git and native Pi session decoding require lossless stdout. Persisted cards retain 100 recent activities plus the exact total count, and diagnostics remain bounded and local. Effect `Sink` activates when a downstream boundary permits incremental or truncated consumption. |
| Testing | Effect/Vitest layers, property tests, deterministic pure clock seams, isolated cadence regressions, integration tests, terminal E2E, and inspected PNG evidence validate behavior. |
| Code Style | Branded identifiers, exhaustive `Match`, generators, compact pipelines, strict Effect TSGO diagnostics, and repository Prettier configuration are enforced. |
| Data Types | `Cause`, `Duration`, `Exit`, `HashMap`, `HashSet`, `Option`, `Redacted`, and `Result` model their matching domain values. `BigDecimal` activates when Pi supplies decimal billing data; inventing a parallel cost model is prohibited. |
| Equal, Hash, Equivalence, Order | Native Pi identity, paths, and session ordering remain authoritative. Effect equality and ordering activate for pi-gentic-owned value objects; applying competing semantics to mutable native host objects is prohibited. |
| Schema | Boundary decoding, tagged classes and errors, brands, transformations, generated JSON Schema, equivalence, arbitrary values, and formatted diagnostics share one contract. |
| AI | Pi remains the sole model and provider executor. Effect AI may describe structured planning/results at the adapter, but may never replace or narrow Pi model capabilities. |
| Micro | Micro is an alternative runtime rather than an additional layer. Pi-gentic uses full Effect because scopes, layers, streams, cache, metrics, and managed fibers are required. |
| Platform | Node `FileSystem`, filesystem watching, `Path`, `ChildProcessSpawner`, process streams, and host terminal utilities preserve platform capabilities. Large Pi session summaries run through the exact-version native loader outside the TUI event loop. Key-value persistence remains Pi JSONL, and terminal ownership remains Pi TUI. |

## Source reduction

The `336a484` baseline contained 10,769 TypeScript source lines. The current implementation contains 9,773, a reduction of 996 lines or 9.2%. Capability parity remains the hard limit on deletion. The count is produced from tracked runtime source with:

```sh
git ls-files 'src/*.ts' 'src/**/*.ts' | xargs cat | wc -l
```
