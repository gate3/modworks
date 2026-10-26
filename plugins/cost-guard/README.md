# Cost guard

A Claude Code mod that helps long sessions use less of your usage limits.

- **Pane:** shows your weekly and 5-hour usage limits and how full the context is. A small critter carries one box for each slice of the conversation.
- **Auto compact:** when the context reaches the threshold you pick (100K to 500K, or any value with `/cost-guard threshold 250k`), Cost guard compacts the conversation. Claude carries on from the summary, and your earlier messages stay on screen.
- **Idle compact:** when you've been away and the context is over 80K tokens, compacts before the prompt cache expires.
- **Trim output:** cuts very long Bash output and saves the full text to a file Claude can read if it needs more.
- **Cheaper subagents** (off by default): runs Explore subagents on a smaller model.

## Commands

- `/cost-guard`: open the pane
- `/cost-guard on` or `/cost-guard off`: turn auto compact on or off
- `/cost-guard threshold <tokens>`: set the compact point, for example `150k`
- `/cost-guard status`: show the current settings
- `/handoff`: compact now

## Install

```bash
claude plugin marketplace add gate3/modworks
```

```bash
claude plugin install cost-guard@modworks
```
