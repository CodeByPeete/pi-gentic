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
| Scheduling | `Schedule` drives live repaint cadence. Effect timeouts bound Git, and retry schedules are restricted to classified transient failures. |
| State Management | `SubscriptionRef`, `SynchronizedRef`, immutable `HashMap`, and cache state model runtime metadata and atomic transitions. |
| Batching | Native Pi listing is the single source. Concurrent requests are coalesced by Effect `Cache`; metadata enrichment runs in bounded chunks. Request batching is reserved for a public Pi batch boundary. |
| Caching | Effect `Cache` owns hydrated native session lists. Fingerprints invalidate small lists, while large lists use stale-while-revalidate with immediate skeletons. |
| Concurrency | `Fiber`, `FiberMap`, `Semaphore`, interruption, and managed runtime ownership cover delegation and presentation concurrency. Queue, PubSub, Deferred, and Latch are used only where ordered backpressure, fan-out, one-shot completion, or readiness are domain requirements. |
| Stream | Scoped child-process output uses `Stream`; session event streams remain at the native Pi subscription boundary until Pi exposes a pull-based stream contract. |
| Sink | Stream consumers use bounded collection for Git output. Activity and diagnostic sinks must stay bounded and local. |
| Testing | Effect/Vitest layers, property tests, deterministic clocks where injected, integration tests, terminal E2E, and inspected PNG evidence validate behavior. |
| Code Style | Branded identifiers, exhaustive `Match`, generators, compact pipelines, strict Effect TSGO diagnostics, and repository Prettier configuration are enforced. |
| Data Types | `Cause`, `Duration`, `Exit`, `HashMap`, `HashSet`, `Option`, `Redacted`, and `Result` model their matching domain values. `BigDecimal` activates when Pi supplies decimal billing data; inventing a parallel cost model is prohibited. |
| Equal, Hash, Equivalence, Order | Stable session identity, deduplication, capability equality, and deterministic tree ordering use the matching Effect semantics where values leave native Pi objects. |
| Schema | Boundary decoding, tagged classes and errors, brands, transformations, generated JSON Schema, equivalence, arbitrary values, and formatted diagnostics share one contract. |
| AI | Pi remains the sole model and provider executor. Effect AI may describe structured planning/results at the adapter, but may never replace or narrow Pi model capabilities. |
| Micro | Micro is an alternative runtime rather than an additional layer. Pi-gentic uses full Effect because scopes, layers, streams, cache, metrics, and managed fibers are required. |
| Platform | Node `FileSystem`, `Path`, `ChildProcessSpawner`, process streams, and host terminal utilities preserve platform capabilities. Key-value persistence remains Pi JSONL, and terminal ownership remains Pi TUI. |

## Source reduction

The `336a484` baseline contained 10,769 TypeScript source lines. The current implementation contains 9,056, a reduction of 1,713 lines or 15.9%. The count is produced from tracked runtime source with:

```sh
find src -name '*.ts' -type f -print0 | xargs -0 cat | wc -l
```
