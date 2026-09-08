import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
// Telegram plugin module implements bot native commands behavior.
import { resolveTelegramOutboundMediaRoots } from "./outbound-media-roots.js";

export { ensureConfiguredBindingRouteReady } from "openclaw/plugin-sdk/conversation-runtime";
export {
  finalizeInboundContext,
  resolveChunkMode,
} from "openclaw/plugin-sdk/reply-dispatch-runtime";
export { resolveThreadSessionKeys } from "openclaw/plugin-sdk/routing";
export { getSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";

/**
 * Derives native-command routing and requester inputs for Telegram's shared
 * delivery-root owner. Configured roots opt in to its stricter policy gate.
 */
export function resolveNativeCommandOutboundMediaRoots(params: {
  cfg: OpenClawConfig;
  route: { agentId: string; sessionKey: string; accountId: string };
  auth: { isGroup: boolean; chatId: number; senderId?: string };
}): readonly string[] {
  return resolveTelegramOutboundMediaRoots({
    cfg: params.cfg,
    agentId: params.route.agentId,
    sessionKey: params.route.sessionKey,
    accountId: params.route.accountId,
    groupId: params.auth.isGroup ? String(params.auth.chatId) : undefined,
    requesterSenderId: params.auth.senderId,
  });
}
