# WS1 Foundation Report

## Changed

- `server.mjs`: MCP server named **Alpaca Bot Bridge**; registers broker/runtime/reconciliation arrays, validates strict object schemas, requires `mode: paper|live` on `broker_*` and `bot_*`, returns sanitized structured error envelopes, preserves handler JSON (including broker status/details), and marks failed broker envelopes as MCP errors.
- `index.mjs`: stdio entry point; includes bounded `repo_*` reads and excludes generic shell/filesystem tools.
- `package.json`, `package-lock.json`: pinned official MCP server/client SDK and Zod dependencies; `npm start` and `npm run check` scripts.
- `foundation.check.mjs`: initializes the local stdio server, reads the actual advertised catalog, verifies tool names, strict schemas, and explicit mode enums, and checks nested broker 207 partial failures retain their structured details while setting MCP `isError`.
- `README.md`: local startup, mode scope, and verification scope.

## Evidence

- `npm ci --ignore-scripts` installed the pinned packages successfully.
- `npm run check` passed: **34 tools advertised; no broker operation called**. The injected nested 207 partial-failure check also passed.
- `node --check server.mjs` and `node --check index.mjs` passed.
- No broker request, bot start/stop, LIVE action, or order mutation was used for verification.

## Tunnel handoff

The requested tunnel is `tunnel_6ab840fdf5e08191bbadd06feb50717a`. Root verified its current scope as organization `org-iI5LO9LabE8wr4oNas5520Ca` and workspace `40cf9754-41e1-4d8a-bae9-bdaf38f0d6e8`. As directed, this worker did not connect or modify tunnel state. Root can run:

```sh
/opt/homebrew/bin/tunnel-client runtimes connect --alias alpaca-bot-bridge --profile alpaca-bot-bridge --admin-profile default --tunnel-id tunnel_6ab840fdf5e08191bbadd06feb50717a --name "Alpaca Bot Bridge" --description "Bounded Alpaca broker, bot runtime, repository read, and reconciliation tools." --mcp-command "/opt/homebrew/bin/node /Users/josephstew/The-Final-Trading-Bot-V5/alpaca-bot-bridge/index.mjs" --runtime-api-key env:CONTROL_PLANE_API_KEY
```

Then check the new alias with `/opt/homebrew/bin/tunnel-client runtimes status alpaca-bot-bridge --json` and require healthy, ready, and control-plane poll health. The available Tunnel MCP/CLI surfaces expose alias listing, connect/create, and runtime status. Remote catalog discovery is supported through the OpenAI Responses API MCP definition using `tunnel_id` (see [Secure MCP tunnels](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)); root will run that probe after connecting. Local stdio catalog exposure is verified; remote catalog exposure remains unverified by this worker.

## Final protocol compatibility result

The launcher uses the raw `StdioServerTransport` path. Its local regression confirms that `server/discover` returns method-not-found, after which an MCP `2025-11-25` initialize, `tools/list`, and read-only `repo_status` call succeed. A `broker_account` call without an explicit `mode` is rejected before execution. `npm run check` passes with 34 tools advertised and no broker operation called. The production launcher is unchanged by this compatibility follow-up. Root separately verified the final remote read evidence; see the current-state record in `VERIFICATION.md`.
