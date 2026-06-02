# X (Twitter)

Post tweets, replies, quotes, search, and manage Twitter/X presence.

Package: `@phantasy/plugin-x`
Repo: https://github.com/phantasy-bot/plugin-x

## Status

This repository is the standalone source for the X (Twitter) plugin. It ships an installable Phantasy plugin package instead of keeping this optional capability in the core Phantasy runtime.

## Development

```bash
npm install
npm run typecheck
npm run build
npm pack --dry-run
```

## Runtime Contract

The plugin uses the public `@phantasy/agent/plugins` and `@phantasy/agent/plugin-runtime` surfaces. Do not import private paths from the Phantasy monorepo.
