// Nextcloud Talk tests cover approval auth plugin behavior.
import { describe, expect, it } from "vitest";
import { nextcloudTalkApprovalAuth } from "./approval-auth.js";

describe("nextcloudTalkApprovalAuth", () => {
  it("authorizes bare approver ids for their Talk user actor only", () => {
    const cfg = { channels: { "nextcloud-talk": { allowFrom: [" nc-talk: Owner "] } } };
    const authorize = (senderId: string) =>
      nextcloudTalkApprovalAuth.authorizeActorAction({
        cfg,
        senderId,
        action: "approve",
        approvalKind: "exec",
      }).authorized;

    expect(authorize("users/owner")).toBe(true);
    expect(authorize("guests/owner")).toBe(false);
  });
});
