import {
  type RouteHandler,
  type AdminApiContext,
  type AdminApiResponse,
  createPluginModuleLogger,
  getRuntimePluginManager,
  type PluginManager,
} from "@phantasy/agent/plugin-runtime";
import type { BasePlugin, PlatformCapability } from "@phantasy/agent/plugins";

const logger = createPluginModuleLogger("TwitterRoutes");

export class TwitterRoutes implements RouteHandler {
  private async getPluginManager(context: AdminApiContext): Promise<PluginManager> {
    return getRuntimePluginManager({ env: context.env });
  }

  async handle(context: AdminApiContext): Promise<AdminApiResponse> {
    const { request, path } = context;
    const method = request.method;

    if (path === "/admin/api/integrations/twitter/status") {
      if (method === "GET") {
        return this.getTwitterStatus(context);
      }
    }

    if (path === "/admin/api/integrations/twitter/start") {
      if (method === "POST") {
        return this.startTwitterBot(context);
      }
    }

    if (path === "/admin/api/integrations/twitter/stop") {
      if (method === "POST") {
        return this.stopTwitterBot(context);
      }
    }

    if (path === "/admin/api/integrations/twitter/test") {
      if (method === "POST") {
        return this.testTwitterConnection(context);
      }
    }

    if (path === "/admin/api/integrations/twitter/test-autonomous") {
      if (method === "POST") {
        return this.testAutonomousPosting(context);
      }
    }

    return {
      handled: false,
      response: new Response("Not found", { status: 404 }),
    };
  }

  private async getTwitterPlugin(
    context: AdminApiContext,
  ): Promise<(BasePlugin & PlatformCapability) | undefined> {
    const pm = await this.getPluginManager(context);
    const plugin = pm.getPlugin("x");
    if (plugin && 'startBot' in plugin) {
      return plugin as BasePlugin & PlatformCapability;
    }
    return undefined;
  }

  private async getTwitterStatus(
    context: AdminApiContext,
  ): Promise<AdminApiResponse> {
    try {
      logger.info("Getting Twitter bot status");
      const plugin = await this.getTwitterPlugin(context);
      
      let status = {
        enabled: plugin?.isEnabled?.() || false,
        connected: false,
        streaming: false,
        autonomousPosting: false,
        error: undefined as string | undefined,
      };
      if (plugin) {
        try {
          const botStatus = await plugin.getBotStatus();
          status = {
            enabled: plugin.isEnabled(),
            connected: botStatus.connected,
            streaming: botStatus.streaming || false,
            autonomousPosting: botStatus.autonomousPosting || false,
            error: botStatus.error,
          };
        } catch (e) {
          logger.warn("Failed to get bot status:", e);
          status.error = e instanceof Error ? e.message : String(e);
        }
      }

      logger.info("Twitter bot status:", status);

      return {
        handled: true,
        response: new Response(JSON.stringify(status), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      };
    } catch (error) {
      logger.error("Error getting Twitter status:", error);
      return {
        handled: true,
        response: new Response(
          JSON.stringify({ error: "Failed to get status", details: String(error) }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        ),
      };
    }
  }

  private async startTwitterBot(
    context: AdminApiContext,
  ): Promise<AdminApiResponse> {
    try {
      const body = await context.request.json().catch(() => ({}));
      const config = body.config || {};

      const plugin = await this.getTwitterPlugin(context);
      if (!plugin) {
        return {
          handled: true,
          response: new Response(
            JSON.stringify({ success: false, error: "Twitter plugin not found" }),
            { status: 404, headers: { "Content-Type": "application/json" } },
          ),
        };
      }

      await plugin.onInit({} as any, config);
      const result = await plugin.startBot();

      return {
        handled: true,
        response: new Response(JSON.stringify(result), {
          status: result.success ? 200 : 400,
          headers: { "Content-Type": "application/json" },
        }),
      };
    } catch (error) {
      logger.error("Error starting Twitter bot:", error);
      return {
        handled: true,
        response: new Response(
          JSON.stringify({ success: false, error: String(error) }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        ),
      };
    }
  }

  private async stopTwitterBot(
    context: AdminApiContext,
  ): Promise<AdminApiResponse> {
    try {
      const plugin = await this.getTwitterPlugin(context);
      if (!plugin) {
        return {
          handled: true,
          response: new Response(
            JSON.stringify({ success: false, error: "Twitter plugin not found" }),
            { status: 404, headers: { "Content-Type": "application/json" } },
          ),
        };
      }

      const result = await plugin.stopBot();

      return {
        handled: true,
        response: new Response(JSON.stringify(result), {
          status: result.success ? 200 : 400,
          headers: { "Content-Type": "application/json" },
        }),
      };
    } catch (error) {
      logger.error("Error stopping Twitter bot:", error);
      return {
        handled: true,
        response: new Response(
          JSON.stringify({ success: false, error: String(error) }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        ),
      };
    }
  }

  private async testTwitterConnection(
    context: AdminApiContext,
  ): Promise<AdminApiResponse> {
    try {
      const body = await context.request.json().catch(() => ({}));
      const { apiKey, apiSecret, accessToken, accessSecret } = body;

      if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
        return {
          handled: true,
          response: new Response(
            JSON.stringify({
              success: false,
              error: "Missing required Twitter credentials",
            }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          ),
        };
      }

      const { TwitterApi } = await import("twitter-api-v2");
      const client = new TwitterApi({
        appKey: apiKey,
        appSecret: apiSecret,
        accessToken,
        accessSecret,
      });

      const me = await client.v2.me();

      return {
        handled: true,
        response: new Response(
          JSON.stringify({
            success: true,
            username: me.data.username,
            userId: me.data.id,
            message: `Successfully connected as @${me.data.username}`,
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      };
    } catch (error) {
      logger.error("Twitter connection test failed:", error);
      const err = error as { message?: string; code?: number };
      return {
        handled: true,
        response: new Response(
          JSON.stringify({
            success: false,
            error: err?.message || "Connection test failed",
            code: err?.code,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      };
    }
  }

  private async testAutonomousPosting(
    context: AdminApiContext,
  ): Promise<AdminApiResponse> {
    try {
      const body = await context.request.json().catch(() => ({}));
      const message =
        typeof body.message === "string" && body.message.trim()
          ? body.message.trim()
          : "Admin UI autonomous posting test";

      const plugin = await this.getTwitterPlugin(context);
      if (!plugin) {
        return {
          handled: true,
          response: new Response(
            JSON.stringify({ success: false, error: "Twitter plugin not found" }),
            { status: 404, headers: { "Content-Type": "application/json" } },
          ),
        };
      }

      const result = await plugin.sendMessage?.({
        content: message,
      });

      return {
        handled: true,
        response: new Response(
          JSON.stringify({
            success: true,
            message: "Test tweet posted successfully",
            connected: true,
            messageId: result?.messageId,
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
      };
    } catch (error) {
      logger.error("Autonomous posting test failed:", error);
      return {
        handled: true,
        response: new Response(
          JSON.stringify({
            success: false,
            error: String(error),
          }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        ),
      };
    }
  }
}
