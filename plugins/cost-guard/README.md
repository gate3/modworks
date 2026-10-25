# Cost guard

A Claude Code mod that helps long sessions use less of your usage limits.

- **Pane:** shows your weekly and 5-hour usage limits and how full the context is. A small critter carries one box for each slice of the conversation.
- **Auto handoff:** when the context reaches the threshold you pick (100K to 500K, or any value with `/cost-guard threshold 250k`), Cost guard saves a handoff note, clears the conversation and continues in a fresh context.
- **Idle handoff:** when you've been away and the context is over 80K tokens, hands off before the prompt cache expires.
- **Trim output:** cuts very long Bash output and saves the full text to a file Claude can read if it needs more.
- **Cheaper subagents** (off by default): runs Explore subagents on a smaller model.

## Commands

- `/cost-guard`: open the pane
- `/cost-guard on` or `/cost-guard off`: turn auto handoff on or off
- `/cost-guard threshold <tokens>`: set the handoff point, for example `150k`
- `/cost-guard status`: show the current settings
- `/handoff`: hand off now

Handoff notes are saved to `~/.claude/cost-guard/handoffs/`.

## Install

```
/plugin install cost-guard --marketplace gate3/modworks
```
