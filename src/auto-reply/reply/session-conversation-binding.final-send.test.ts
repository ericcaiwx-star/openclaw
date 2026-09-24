import { describe, expect, it } from "vitest";
import {
  copyConversationBindingRouteFacts,
  withConversationBindingRouteFacts,
} from "../../channels/conversation-binding-route-facts.js";
import { SessionWorkStartChangedError } from "../../config/sessions/lifecycle.js";
import { testing as genericBindingTesting } from "../../infra/outbound/current-conversation-bindings.js";
import type { SessionBindingRecord } from "../../infra/outbound/session-binding-service.js";
import { assertPreparedConversationBindingRouteNow } from "./session-conversation-binding.js";
import { buildTestCtx } from "./test-ctx.js";

describe("assertPreparedConversationBindingRouteNow", () => {
  const conversation = {
    channel: "webchat",
    accountId: "default",
    conversationId: "final-send-binding",
  };
  const sessionKey = "agent:main:webchat:direct:final-send-binding";
  const observed: SessionBindingRecord = {
    bindingId: "binding-observed",
    boundAt: 1,
    targetKind: "session",
    targetSessionKey: sessionKey,
    conversation,
    status: "active",
  };

  function ctxFor(binding: SessionBindingRecord) {
    const route = withConversationBindingRouteFacts(
      { sessionKey, agentId: "main" },
      { kind: "agent", binding, sessionKey },
      "main",
      conversation,
    );
    const ctx = buildTestCtx({
      Provider: "webchat",
      Surface: "webchat",
      ChatType: "direct",
      From: "user:final-send",
      To: "channel:final-send",
      AgentId: "main",
      SessionKey: sessionKey,
    });
    copyConversationBindingRouteFacts(route, ctx);
    return ctx;
  }

  it("does not query SQLite before a generic binding is published", () => {
    genericBindingTesting.clearPublishedGenericCurrentConversationBindingsForTests();
    expect(() => assertPreparedConversationBindingRouteNow(ctxFor(observed))).not.toThrow();
  });

  it("refuses a published generic binding change without a synchronous SQLite read", () => {
    genericBindingTesting.rememberPublishedGenericCurrentConversationBinding(
      conversation,
      observed,
    );
    expect(() => assertPreparedConversationBindingRouteNow(ctxFor(observed))).not.toThrow();
    genericBindingTesting.rememberPublishedGenericCurrentConversationBinding(conversation, {
      ...observed,
      bindingId: "binding-reassigned",
      boundAt: 2,
    });
    expect(() => assertPreparedConversationBindingRouteNow(ctxFor(observed))).toThrow(
      SessionWorkStartChangedError,
    );
    genericBindingTesting.clearPublishedGenericCurrentConversationBindingsForTests();
  });
});
