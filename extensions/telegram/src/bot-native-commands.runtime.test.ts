import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-local-roots";
import { describe, expect, it } from "vitest";
import { resolveNativeCommandOutboundMediaRoots } from "./bot-native-commands.runtime.js";

const route = {
  agentId: "qa",
  sessionKey: "agent:qa:telegram:group:-100123",
  accountId: "default",
};
const auth = { isGroup: true, chatId: -100123, senderId: "2468" };

describe("Telegram outbound media feature enablement", () => {
  for (const denial of ["sender", "group"] as const) {
    const makeConfig = (mediaLocalRoots?: string[]): OpenClawConfig => ({
      agents: {
        defaults: { workspace: "/tmp/telegram-active-workspace", mediaLocalRoots },
        list: [{ id: "qa" }],
      },
      tools: {
        profile: "full",
        ...(denial === "sender" ? { toolsBySender: { "id:2468": { deny: ["read"] } } } : {}),
      },
      channels: {
        telegram: {
          groups: {
            "-100123": denial === "group" ? { tools: { deny: ["read"] } } : {},
          },
        },
      },
    });

    it.each([
      { label: "absent", roots: undefined },
      { label: "empty", roots: [] },
    ])(
      `retains released delivery roots under ${denial} denial when roots are $label`,
      ({ roots }) => {
        const cfg = makeConfig(roots);
        const result = resolveNativeCommandOutboundMediaRoots({ cfg, route, auth });
        expect(result).toEqual(getAgentScopedMediaLocalRoots(cfg, route.agentId));
        expect(result).toContain("/tmp/telegram-active-workspace");
      },
    );

    it(`does not fall back to released roots after configured ${denial} denial`, () => {
      const cfg = makeConfig(["/tmp/telegram-configured-media"]);
      const result = resolveNativeCommandOutboundMediaRoots({ cfg, route, auth });
      expect(result).not.toContain("/tmp/telegram-active-workspace");
      expect(result).not.toContain("/tmp/telegram-configured-media");
      expect(result.length).toBeGreaterThan(0);
    });
  }
});
