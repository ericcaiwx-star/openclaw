import { createChannelApprovalAuth } from "openclaw/plugin-sdk/approval-auth-runtime";
import { resolveNextcloudTalkAccount } from "./accounts.js";
import { normalizeNextcloudTalkAllowEntry } from "./policy.js";
import type { CoreConfig } from "./types.js";

export const nextcloudTalkApprovalAuth = createChannelApprovalAuth({
  channelLabel: "Nextcloud Talk",
  resolveInputs: ({ cfg, accountId }) => {
    const account = resolveNextcloudTalkAccount({ cfg: cfg as CoreConfig, accountId });
    return { allowFrom: account.config.allowFrom };
  },
  normalizeApprover: (value) => normalizeNextcloudTalkAllowEntry(String(value)) || undefined,
}).approvalAuth;
