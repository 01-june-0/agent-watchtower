---
description: Start the Agent Watchtower dashboard for the Claude Code sessions on this machine
allowed-tools: Bash
---

# Start Agent Watchtower

Start the local, read-only Agent Watchtower dashboard and tell the user where it is.

1. Check that Node.js 22 or newer is available with `node --version`. If it is missing or older, tell the user that Agent Watchtower needs Node.js 22+ and stop.
2. Run this command **in the background** (it keeps running until stopped), passing along any arguments the user gave (`$ARGUMENTS`), for example `--port 4488`, `--hours 48` or `--no-open`:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/bin/agent-watchtower.mjs" $ARGUMENTS
   ```

3. Read the first lines of its output. It prints either `Running at <address>` (`http://127.0.0.1:4477` by default, or the next free port if that one is taken) or `Already running at <address>` when Watchtower is already up; in that case it exits on its own and nothing else is needed. If it says the port is used by another program, tell the user that and suggest leaving out `--port`.
4. Tell the user the address in one line. Do not summarize what the dashboard shows.

The server listens on 127.0.0.1 only, reads transcripts without changing them, and sends nothing off this machine.
