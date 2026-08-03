# Auction Profile Macro Composite

Macro Composite consumes up to 20,000 loaded chart bars and is never derived from the visible camera window. Its scope, grid origin, row size, source revision, and settings hash are part of the immutable profile version.

Periodic Composite divides the requested history into deterministic periods. Fixed and Manual scopes freeze explicit boundaries. Rolling scope evolves by definition; strategies must freeze the profile version and key levels when a setup is armed.

Rebuilds occur when scope, grid, engine, settings, corrected history, or material source coverage changes. New trades use the worker's incremental path.
