import type { ReplyToolAuthorityOverlay } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import { QuestionDispatchRefusedError } from "./gateway-question-dispatch.js";

type CallerQuestionState = {
  answerAuthority?: {
    assertCaller: (caller: ReplyToolAuthorityOverlay) => void;
  } | null;
};

/** Source-bound authority for a creator-policy claim. The current check stays synchronous. */
export function createSourceBoundCallerAuthority(
  params: {
    caller?: ReplyToolAuthorityOverlay;
    callerFingerprint?: string;
    creatorFingerprint?: string;
    assertSourceCurrent: () => void;
  },
  state: CallerQuestionState | undefined,
  isCurrent: () => boolean,
) {
  const fingerprintRefused =
    !params.creatorFingerprint || params.callerFingerprint !== params.creatorFingerprint;
  return {
    kind: "source-bound" as const,
    assertCurrent: () => {
      try {
        params.assertSourceCurrent();
        if (state && params.caller) {
          if (!state.answerAuthority) {
            throw new Error("pending question has no prepared creator authority");
          }
          state.answerAuthority.assertCaller(params.caller);
        } else if (state && fingerprintRefused) {
          throw new Error("question answer caller policy does not match its creator");
        }
        if (state && !isCurrent()) {
          throw new Error("pending question is no longer current");
        }
        params.assertSourceCurrent();
      } catch (error) {
        throw new QuestionDispatchRefusedError(
          error instanceof Error ? error.message : "question answer authority refused",
          { cause: error },
        );
      }
    },
  };
}
