# @phantasy/plugin-x

- Repo URL: https://github.com/phantasy-bot/plugin-x
- Extraction phase: `source-extracted`
- Source of truth: `standalone-repo`
- Runtime load mode: `git`
- Source owner: `standalone-repo`
- Source payload: `standalone-only`
- Monorepo package status: `removed`
- Sync mode: `standalone-repo`

## Meaning

This repo now owns the real standalone implementation payload for X (Twitter). Core Phantasy should keep only the plugin contract, loader, catalog metadata, and generic proxy routes.

## Next Step

Publish `@phantasy/plugin-x` after the core `@phantasy/agent` peer package exposes the plugin runtime subpaths required by this plugin.
