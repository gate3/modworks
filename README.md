# Modworks

A collection of mods for Claude Code. Each mod lives in its own folder under `plugins/`, and you can install any of them on its own.

## Mods

| Mod | What it does |
| --- | --- |
| [cost-guard](plugins/cost-guard) | A side pane that shows your usage limits and how full the context is. At a threshold you pick, it saves a handoff note and continues in a fresh context. It also trims long tool output. |

## Install a mod

At the prompt of a Claude Code terminal session:

```
/plugin install cost-guard --marketplace gate3/modworks
```

Answer `y` to add the marketplace, then pick a scope. User scope loads the mod in every session.

From a shell:

```bash
claude plugin install cost-guard --marketplace gate3/modworks
```

In the desktop app: click **+** next to the prompt box, then **Plugins** > **Add marketplace**, enter `gate3/modworks`, then **Add plugin**.

To install a different mod, swap `cost-guard` for that mod's name.

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
