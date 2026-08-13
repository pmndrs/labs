<!-- managed:start -->

## Workspace Tools

- **Package Manager:** pnpm
- **Linter:** oxlint
- **Formatter:** prettier

### After Editing

✅ After editing files, check the types for errors and then format and lint only the files changed for the current task.

```sh
# Example
pnpm typecheck
# Run format and lint for only files modified
pnpm exec prettier --config .config/prettier.json --ignore-path .config/prettierignore --write src/App.tsx src/core/systems/move-entity.ts
pnpm lint -- src/App.tsx src/core/systems/move-entity.ts
```

❌ Avoid unless explicitly approved:

```sh
pnpm format
pnpm lint
```

<!-- managed:end -->
