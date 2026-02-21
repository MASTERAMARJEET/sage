import { routeAgentRequest } from "agents";
import { SageAgent } from "./agents/orchestrator";
import type { AppEnv } from "./types/env";

export { SageAgent };

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        status: "ok",
        service: "sage-brain",
        env: env.APP_ENV
      });
    }

    const agentResponse = await routeAgentRequest(request, env);
    if (agentResponse) {
      return agentResponse;
    }

    return new Response("Not found", { status: 404 });
  }
} satisfies ExportedHandler<AppEnv>;
