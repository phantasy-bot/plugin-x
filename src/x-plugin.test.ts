import { beforeEach, describe, expect, it, vi } from "vitest";

const xServiceMock = vi.hoisted(() => ({
  createDraftReply: vi.fn(async () => ({ notificationId: "draft-reply", success: true })),
  createDraftTweet: vi.fn(async () => ({ notificationId: "draft-tweet", success: true })),
  deleteTweet: vi.fn(async () => ({ success: true })),
  hasCredentials: vi.fn(async () => true),
  replyToTweet: vi.fn(async () => ({ replyId: "reply-1", success: true })),
  reset: vi.fn(),
  testConnection: vi.fn(async () => ({ success: true, username: "phantasy_ai" })),
  tweet: vi.fn(async () => ({ success: true, tweetId: "tweet-1" })),
}));

vi.mock("./x-service", () => ({
  xService: xServiceMock,
}));

import { XPlugin } from "./x-plugin";

describe("XPlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("declares a generic admin surface until the native bundle is built in-repo", async () => {
    const plugin = new XPlugin();

    await plugin.onInit({ id: "agent" } as never, {});

    expect(plugin.getManifest().adminSurface).toMatchObject({
      kind: "generic",
      tabId: "x",
    });
  });

  it("supports normalized platform status and test endpoints", async () => {
    const plugin = new XPlugin();

    await plugin.onInit({ id: "agent" } as never, {
      autonomousPosting: true,
      enabled: true,
      requireApproval: true,
    });

    const statusResponse = await plugin.handleCustomEndpoint(
      new Request("http://localhost/status"),
      "/status",
    );

    await expect(statusResponse!.json()).resolves.toMatchObject({
      autonomousPosting: true,
      connected: true,
      enabled: true,
    });

    const testResponse = await plugin.handleCustomEndpoint(
      new Request("http://localhost/test-connection", { method: "POST" }),
      "/test-connection",
    );

    await expect(testResponse!.json()).resolves.toMatchObject({
      success: true,
      username: "phantasy_ai",
    });
    expect(xServiceMock.testConnection).toHaveBeenCalledTimes(1);
  });

  it("routes tweet tools through approval drafts when required", async () => {
    const plugin = new XPlugin();

    await plugin.onInit({ id: "agent" } as never, {
      enabled: true,
      requireApproval: true,
    });

    const postTool = plugin
      .getTools()
      .find((tool) => tool.name === "x_post_tweet");

    const result = await postTool!.handler({ text: "Hello from Phantasy" });

    expect(result).toMatchObject({ notificationId: "draft-tweet", success: true });
    expect(xServiceMock.createDraftTweet).toHaveBeenCalledWith("Hello from Phantasy");
    expect(xServiceMock.tweet).not.toHaveBeenCalled();
  });
});
