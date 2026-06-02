/**
 * Worker entrypoint. Single route:
 *
 *   POST /issue   { issue_url, webhook_url }
 *
 * Derives a stable agent name from the issue URL, binds the webhook
 * URL into the agent, kicks off `TRIAGE_WORKFLOW`, and returns
 * `{ workflowId, agentName }`.
 *
 * The TriageAgent and TriageWorkflow classes are re-exported so the
 * runtime can find them by class name (DO + Workflow bindings in
 * wrangler.jsonc).
 *
 * WorkspaceProxy is also re-exported so the runtime can build the
 * loopback binding the Container backend uses for egress.
 */

import { getAgentByName } from "agents";
import { TriageAgent, WorkspaceProxy } from "./agent.js";
import { TriageWorkflow } from "./workflow.js";

export { TriageAgent, TriageWorkflow, WorkspaceProxy };

interface IssueRequest {
  issue_url?: unknown;
  webhook_url?: unknown;
  /** Optional. When true, every tool call and assistant text is mirrored to the webhook as `{ type: "debug", … }`. */
  debug?: unknown;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/issue") {
      let body: IssueRequest;
      try {
        body = (await request.json()) as IssueRequest;
      } catch {
        return json({ error: "Body must be JSON" }, 400);
      }
      const issueUrl = typeof body.issue_url === "string" ? body.issue_url : null;
      const webhookUrl = typeof body.webhook_url === "string" ? body.webhook_url : null;
      const debug = body.debug === true;
      if (!issueUrl || !webhookUrl) {
        return json({ error: "Required: issue_url, webhook_url (both strings)" }, 400);
      }
      const agentName = agentNameForIssue(issueUrl);
      const agent = await getAgentByName<Env, TriageAgent>(env.TriageAgent, agentName);
      await agent.setContext({ issueUrl, webhookUrl, debug });
      const workflowId = await agent.startTriage({ issueUrl });
      return json({ agentName, workflowId }, 202);
    }

    if (url.pathname === "/" || url.pathname === "") {
      return new Response(
        [
          "think example",
          "",
          "  POST /issue   { issue_url, webhook_url, debug? }",
          "",
          "    Kicks off a TriageWorkflow that clones the repo,",
          "    triages the issue, attempts a fix, and POSTs progress",
          "    + a final DONE payload to webhook_url.",
        ].join("\n"),
        { headers: { "content-type": "text/plain" } },
      );
    }

    return new Response("not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * Map an issue URL to a deterministic agent name so repeated calls
 * against the same issue reuse the same DO + workspace. Strips
 * everything except `owner/repo/issues/N`.
 */
function agentNameForIssue(issueUrl: string): string {
  const match = issueUrl.match(/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/);
  if (!match) {
    // Fall back to a hash-free dump of the URL so the user still gets
    // a stable name. Strips anything not safe for a DO name.
    return issueUrl.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 64);
  }
  const [, owner, repo, num] = match;
  return `${owner}-${repo}-${num}`;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}
