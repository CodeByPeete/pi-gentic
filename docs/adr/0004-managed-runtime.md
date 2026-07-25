# Own one managed runtime per extension host

A loaded pi-gentic extension owns one scoped Effect ManagedRuntime and runs application Effects only through boundary adapters. Shared Layers, fibers, subscriptions, caches, child processes, and finalizers therefore have one deterministic lifecycle instead of independent Promise-based registries.
