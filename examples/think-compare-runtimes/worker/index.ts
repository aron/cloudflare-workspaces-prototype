import { routePartykitRequest, Server } from "partyserver";
import { createFakeRunEvents } from "./fake-run";
import { handleApiRequest } from "./http";

export interface Env {
  CompareRun: DurableObjectNamespace<CompareRun>;
}

export class CompareRun extends Server<Env> {
  static override options = { hibernate: true };

  override onConnect(connection: WebSocket): void {
    connection.send(
      JSON.stringify({
        type: "history",
        events: createFakeRunEvents(this.name),
      }),
    );
  }
}

export default {
  async fetch(request, env) {
    const apiResponse = await handleApiRequest(request);

    if (apiResponse) {
      return apiResponse;
    }

    return (await routePartykitRequest(request, env)) ?? new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;
