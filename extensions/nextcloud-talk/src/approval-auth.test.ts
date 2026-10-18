// Nextcloud Talk tests cover approval auth plugin behavior.
import { describe, expect, it } from "vitest";
import { nextcloudTalkApprovalAuth } from "./approval-auth.js";

describe("nextcloudTalkApprovalAuth", () => {
  it("matches Nextcloud Talk actor ids case-insensitively", () => {
    const cfg = { channels: { "nextcloud-talk": { allowFrom: [" nc-talk: Owner "] } } };

    expect(
      nextcloudTalkApprovalAuth.authorizeActorAction({
        cfg,
        senderId: "users/owner",
        action: "approve",
        approvalKind: "exec",
      }),
    ).toEqual({ authorized: true });
  });
});

it("rechecks the current approver list and keeps non-user actors separate", () => {
  const account = { allowFrom: ["owner"] };
  let cfg = { channels: { "nextcloud-talk": account } };
  const authorize = (senderId: string) =>
    nextcloudTalkApprovalAuth.authorizeActorAction({
      cfg,
      senderId,
      action: "approve",
      approvalKind: "exec",
    }).authorized;

  expect(authorize("users/owner")).toBe(true);
  expect(authorize("guests/owner")).toBe(false);
  cfg = { channels: { "nextcloud-talk": { allowFrom: ["other-owner"] } } };
  expect(authorize("users/owner")).toBe(false);
});
