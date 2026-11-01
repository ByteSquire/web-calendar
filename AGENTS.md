# Standing rules for coding agents

## Before writing new code

Climb this ladder and stop at the first rung that works:

1. Skip it if nobody asked for it.
2. Reuse an existing helper or composable in this repo.
3. Use the platform or the standard library.
4. Use a dependency that is already installed.

Never add a dependency for a few lines. A new one must be AGPLv3-compatible (`docs/design.md` §12).

## Never simplify away

Validation, error handling, security checks or accessibility. If a change needs one of them
gone, stop and ask.

## Repo facts (see `docs/design.md`)

- Nuxt 4 (Vue 3, Nitro) with FullCalendar v7 (Premium, AGPLv3, subpath imports).
- Tooling stays: ESLint 10, `vue-tsc` and TypeScript 5.9. Do not swap them out.
- Prettier: single quotes, no semicolons, 100 columns.
- Never run `npm audit fix --force`; it downgrades Nuxt.
- Never commit untracked dotfiles such as `.claude` and `.vscode`.

## Workflow

- Commit only when asked. End the message with the trailer already in `git log`:
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`
- Run the full lint, typecheck, unit and e2e suites only when the user says so.
- End every reply with what was skipped or not verified.
