# Ship gate

A Claude Code mod that holds Claude's commits, pushes and pull requests until your shipping steps are done for the code being shipped.

- **Pane:** a harbor. Your ship waits at the gate, and each step is a signal flag on its lines. A flag goes up when its step is done and comes down if the code changes after it. When every flag is up, the gate opens.
- **The gate:** when Claude runs `git commit`, `git push` or `gh pr create` before the steps are done, Ship gate blocks it and tells Claude which steps are left. Claude does those steps without stopping to ask you, then runs the command again.
- **Tied to the code:** a step counts for the code as it was when the step ran, so a finished step only runs again if the code it covered changes. Fixes made right after a step still count for it, but if more than 100 lines change after it runs, those lines need the step again. Editing UI text doesn't undo a code review, but a change inside a code string, like `'admin'`, does.
- **Review by risk:** when Claude runs `/code-review`, a small change gets a medium-effort review, and any reviewer agents it starts run on Sonnet 5.5. A large change, or one that touches payments, auth, migrations, the database or webhooks, gets a high-effort review, with any reviewer agents on Opus 5.5. A level you type yourself is left as it is.
- **npm repos:** blocks `yarn` and `pnpm` where the lockfile is `package-lock.json`.
- **PR base:** pull requests Claude opens go to `staging` when the repo has that branch, unless the branch name starts with `hotfix`.

## Steps

| Flag | Step | Needed when | Done when |
| --- | --- | --- | --- |
| R | Code review | code changed | `/code-review` ran |
| C | UX copy check | text in a UI file changed (not tests) | `design:ux-copy` ran |
| M | Marketing copy check | a README or marketing page changed | `marketing:brand-review` ran |
| S | Proof | UI files changed | a screenshot or video was sent with SendUserFile |

The copy steps use skills from the `design` and `marketing` plugins. If you don't have them, turn those steps off (below).

Add a step with `/ship-gate add`:

- `/ship-gate add command npm test`: the command has to pass, run on its own, not piped into another command.
- `/ship-gate add skill security-review`: the skill has to run.
- `/ship-gate add approval Design sign-off`: you approve it in the pane.

Or edit the steps file: `~/.claude/ship-gate.json` for every repo, or `.claude/ship-gate.json` in one repo. The repo's file wins.

```json
{
  "steps": [
    { "id": "proof", "off": true },
    { "id": "tests", "name": "Tests pass", "flag": "T", "done": { "command": "npm test" } },
    { "id": "migrations", "name": "Migration sign-off", "flag": "D", "paths": ["migrations/**"], "done": { "approval": true } }
  ],
  "prBase": { "branch": "staging", "except": "^hotfix" },
  "lockfileGuard": true
}
```

Each step can set `gates` (`commit`, `push`, `pr`), `paths` and `exclude` (globs for the files that make it needed), and `done`: `{ "skill": … }`, `{ "command": … }`, `{ "sent": "media" }` or `{ "approval": true }`. Set `"prBase": false` to leave pull requests alone.

## Commands

- `/ship-gate`: open the pane
- `/ship-gate status`: list the steps for the current code
- `/ship-gate pass`: let the next commit, push or pull request through once
- `/ship-gate approve <step>`: approve a step that needs your approval
- `/ship-gate on` or `/ship-gate off`: turn the gate on or off

## Install

```bash
claude plugin marketplace add gate3/modworks
```

```bash
claude plugin install ship-gate@modworks
```
