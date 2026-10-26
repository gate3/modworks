# Modworks

A collection of mods for Claude Code. Each mod lives in its own folder under `plugins/`, and you can install any of them on its own.

## Mods

| Mod | What it does |
| --- | --- |
| [cost-guard](plugins/cost-guard) | A side pane that shows your usage limits and how full the context is. At a threshold you pick, it compacts the conversation, and your earlier messages stay on screen. It also trims long tool output. |
| [ship-gate](plugins/ship-gate) | Holds Claude's commits, pushes and pull requests until your steps are done for the current code: code review, copy checks, a screenshot or video, or any step you add. A harbor pane shows each step as a signal flag. |

## Install a mod

From a shell, add this repo as a marketplace once, then install the mod:

```bash
claude plugin marketplace add gate3/modworks
```

```bash
claude plugin install cost-guard@modworks
```

It installs at user scope, so it loads in every new session.

At the prompt of a Claude Code terminal session, the same two steps are `/plugin marketplace add gate3/modworks` and `/plugin install cost-guard@modworks`.

In the desktop app: click **+** next to the prompt box, then **Plugins** > **Add marketplace**, enter `gate3/modworks`, then **Add plugin**.

To install a different mod, swap `cost-guard` for that mod's name. To get the latest version later, run `claude plugin marketplace update modworks`, then `claude plugin update cost-guard@modworks`.

## Repository layout

```
.claude-plugin/marketplace.json   lists every mod in this repo
plugins/
  cost-guard/                     one folder per mod
    .claude-plugin/plugin.json
    hooks/
    tests/
```

### Adding a mod

1. Put the mod in its own folder, `plugins/<mod-name>/`, with its `.claude-plugin/plugin.json`.
2. Add an entry to `.claude-plugin/marketplace.json`: `{ "name": "<mod-name>", "source": "./plugins/<mod-name>" }`.
3. Check it: `claude plugin validate plugins/<mod-name>` and `claude plugin test plugins/<mod-name>`.
4. Add a row to the table above.
