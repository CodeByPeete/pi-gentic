# Pi-Gentic Orchestration

Pi-gentic coordinates durable collaboration between Pi sessions while preserving the resource, trust, and persistence semantics owned by Pi.

## Language

**Agent Definition**:
A named role with instructions and default policy settings.
_Avoid_: Persona, profile

**Agent Activation**:
The persisted selection of one Agent Definition for a Session.
_Avoid_: Current agent, loaded persona

**Capability Ceiling**:
The complete set of native Pi resources that a Session is permitted to use before narrower policy is applied.
_Avoid_: Allowlist, permissions

**Ambient Tool Selection**:
The latest complete active tool selection observed from Pi that was not produced by the current Session Policy.
_Avoid_: Default tools, external tools

**Session Policy**:
The effective restrictions and runtime preferences for one Session.
_Avoid_: Agent config, overrides

**Delegation**:
One request from a Caller Session to a distinct Target Session.
_Avoid_: Task, send call

**Caller Session**:
The Session that initiates a Delegation and receives its outcome.
_Avoid_: Parent, source

**Target Session**:
The existing or newly created Session that handles a Delegation.
_Avoid_: Child, worker

**Delegation Run**:
One execution attempt of a Delegation in its Target Session.
_Avoid_: Agent call, task run

**Delegation Outcome**:
The terminal result of a Delegation Run, classified as completed, failed, stopped, or aborted.
_Avoid_: Tool result, answer

**Return Delivery**:
The durable transfer of a Delegation Outcome to its Caller Session.
_Avoid_: Callback, response

**Joined Delegation**:
A deferred Delegation linked to its active enclosing Delegation Runs. Each enclosing run remains active until the Caller Session processes the outcome. The link follows Delegation identity across Session Runtimes, independently of Agent identity or role.
_Avoid_: Blocking call, nested wait

**Detached Delegation**:
A deferred Delegation whose Return Delivery does not keep an enclosing Delegation open.
_Avoid_: Fire-and-forget task, orphaned call

**Session Runtime**:
A live Pi execution environment attached to one persisted Session identity.
_Avoid_: Host, instance

**Session Transition**:
One visible change to a new, resumed, forked, cloned, or imported Session. Input accepted while its destination opens stays attached to that transition until the destination is ready, cancelled, or failed.
_Avoid_: Global input wait, background completion wait

**Runtime Lease**:
A scoped right to use a Session Runtime while Delegation or presentation work owns it.
_Avoid_: Reference, registration

**Session Tree**:
A parent-child graph derived from Pi session headers.
_Avoid_: Agent tree, process tree

**Card Snapshot**:
The persisted terminal presentation of a Delegation for restoration in a Session.
_Avoid_: UI state, message cache

**Activity**:
Observable progress emitted by a Target Session during a Delegation Run.
_Avoid_: Event, log

**Host Capability**:
An operation from the currently installed Pi host required to preserve pi-gentic behavior. Private capabilities stay contained in the direct Pi integration.
_Avoid_: Version adapter, migration path, scattered private hook
