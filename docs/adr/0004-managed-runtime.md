# Own one managed runtime per extension host

A loaded pi-gentic extension owns one scoped Effect ManagedRuntime and runs application Effects only through boundary adapters. Shared Layers, fibers, subscriptions, caches, child processes, and finalizers therefore have one deterministic lifecycle instead of independent Promise-based registries.

Live TUI repaint delays, periodic timer pulses, and expiry delays are fibers of this runtime. Large session-directory scans also use its platform filesystem services. Runtime disposal interrupts presentation work alongside delegation work, so neither can outlive the extension host.
