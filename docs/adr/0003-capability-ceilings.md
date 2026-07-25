# Resolve monotonic capability ceilings

Every resource policy restricts the capability ceiling inherited from Pi and earlier policy layers. Force inclusion can restore a capability removed inside its own layer only when that capability remains in the incoming ceiling, which prevents project configuration, Agent Definitions, and request overrides from expanding ambient authority.
