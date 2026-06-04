import { createRunSession } from "./runs";

export async function handleApiRequest(
  request: Request,
  createId?: () => string,
): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname !== "/api/runs") {
    return null;
  }

  if (request.method !== "POST") {
    return new Response("Method Not Allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }

  return Response.json(createRunSession(createId), { status: 201 });
}
