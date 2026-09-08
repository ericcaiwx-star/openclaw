import {
  getAgentScopedMediaLocalRoots,
  resolveAgentScopedOutboundMediaAccess,
} from "openclaw/plugin-sdk/media-local-roots";

export function resolveTelegramOutboundMediaRoots(
  params: Pick<
    Parameters<typeof resolveAgentScopedOutboundMediaAccess>[0],
    "cfg" | "agentId" | "sessionKey" | "accountId" | "groupId" | "requesterSenderId"
  >,
): readonly string[] {
  // Preserve released Telegram delivery authority unless the operator opts in.
  // This is feature selection, never a fallback after the shared policy denies.
  if (!params.cfg.agents?.defaults?.mediaLocalRoots?.length) {
    return getAgentScopedMediaLocalRoots(params.cfg, params.agentId);
  }
  return (
    resolveAgentScopedOutboundMediaAccess({ ...params, messageProvider: "telegram" }).localRoots ??
    []
  );
}
