---
name: agents-sdk
description: Cloudflare Agents SDK patterns. Use when designing stateful Durable-Object-backed agents, durable workflows, real-time WebSocket apps, scheduled tasks, MCP servers, or chat applications built on the @cloudflare/agents package.
---

# Cloudflare Agents SDK

The Agents SDK (`agents`, `@cloudflare/agents`) gives you a Durable-Object-backed `Agent` base class with state management, callable RPC, WebSocket fanout, scheduled tasks, and React hooks for the client side.

## When to use it

- The unit of state is a long-lived conversation, room, workflow, or game instance keyed by a stable id.
- Multiple clients connect over WebSocket and need synchronized state.
- You need durable execution (retries, sleep, fan-out) — pair with Workflows.
- You're exposing tools to an LLM via MCP and want session state behind them.

## Quickstart

```ts
import { Agent, routeAgentRequest } from "agents";

export class Counter extends Agent<Env> {
  static options = { hibernate: true };

  async increment(): Promise<number> {
    const next = ((this.state.value as number | undefined) ?? 0) + 1;
    await this.setState({ value: next });
    this.broadcast(JSON.stringify({ type: "count", value: next }));
    return next;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (await routeAgentRequest(request, env)) ?? new Response("not found", { status: 404 });
  },
};
```

`routeAgentRequest` handles `/agents/<class>/<id>/...` URLs, attaches the right DO stub, and upgrades WebSockets when requested.

## State

- `this.state` — the agent's typed state object.
- `this.setState(patch)` — partial updates; SDK merges and persists.
- `this.broadcast(msg)` — push to every connected client.
- `this.sql\`SELECT ...\`` — raw SQLite when state-object shape isn't enough.

## RPC methods

Public methods on the class are callable from the client via `useAgent` or directly via the SDK's RPC client. Return values must be structured-cloneable.

## Hibernation

`static options = { hibernate: true }` lets workerd evict the DO when idle. WebSocket connections survive via the hibernating-WS API — your `onMessage` / `onConnect` handlers wake the DO up.

## Workflows integration

For long-running, retryable work that outlives a single turn, spawn a Cloudflare Workflow from the agent and persist its run id on `this.state`. The workflow can call back into the agent via its DO stub for progress updates.

## MCP servers

The SDK ships an MCP server adapter — expose tools whose implementations close over `this` (the agent instance) so each MCP session has its own conversation, memory, and bindings.

## React hooks

`useAgent({ agent: "Counter", name: "lobby-1" })` opens a typed WebSocket-backed RPC channel from the browser. `useAgentChat` builds on top of it for chat UIs.

## Reference

Pull canonical examples from the upstream repo when unsure:

```
gh repo clone cloudflare/agents /repos/agents
```

Then read under `/repos/agents/examples/` and `/repos/agents/packages/agents/src/`.
