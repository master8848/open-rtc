# Changesets

Pending release notes live here as `*.md` files with YAML front matter naming the
bumped packages. Add one per PR that changes published behavior:

```sh
npm run changeset
```

`npx changeset version` consumes them: bumps versions, updates internal deps,
and writes each package's `CHANGELOG.md`. `npm run release` builds and publishes.
See CONTRIBUTING.md → "Changelog & releases" for the full workflow.
