// Codex tests cover configured transcription for conversation-bound audio.
import { describe, expect, it, vi } from "vitest";
import { prepareCodexConversationAudioPrompt } from "./conversation-audio.js";

const config = { tools: { media: { audio: { enabled: true } } } };
const allAudioConfig = {
  tools: {
    media: { audio: { enabled: true, attachments: { mode: "all" as const, maxAttachments: 4 } } },
  },
};
const selectMediaAttachments: NonNullable<
  Parameters<typeof prepareCodexConversationAudioPrompt>[0]["selectMediaAttachments"]
> = async ({ attachments, policy }) => {
  const matches = attachments.filter((attachment) => !attachment.alreadyTranscribed);
  const ordered = policy?.prefer === "last" ? matches.toReversed() : matches;
  const limit = policy?.mode === "all" ? Math.max(1, policy.maxAttachments ?? 1) : 1;
  return {
    selected: ordered.slice(0, limit),
    droppedAttachmentIndexes: ordered.slice(limit).map((attachment) => attachment.index),
  };
};

function audioEvent(overrides: Record<string, unknown> = {}) {
  return {
    content: "",
    channel: "telegram",
    isGroup: true,
    media: [
      {
        path: "/tmp/voice.ogg",
        contentType: "audio/ogg",
        kind: "audio" as const,
      },
    ],
    ...overrides,
  };
}

describe("Codex conversation audio", () => {
  it("appends configured STT output for every captioned audio attachment", async () => {
    const runMediaUnderstandingFile = vi.fn(async ({ filePath }: { filePath: string }) => ({
      text: filePath.endsWith("voice.ogg") ? 'say "hello"' : "second clip",
    }));

    await expect(
      prepareCodexConversationAudioPrompt({
        prompt: "Please summarize this.",
        event: audioEvent({
          media: [
            { contentType: "audio/ogg", kind: "audio" },
            { path: "/tmp/voice.ogg", contentType: "audio/ogg", kind: "audio" },
            { path: "/tmp/clip.mp3", contentType: "audio/mpeg", kind: "audio" },
          ],
        }),
        config: allAudioConfig,
        agentId: "main",
        agentDir: "/tmp/agent",
        workspaceDir: "/tmp/workspace",
        sessionKey: "agent:main:telegram:group",
        runMediaUnderstandingFile,
        selectMediaAttachments,
      }),
    ).resolves.toBe(
      'Please summarize this.\n\n[Audio transcript (machine-generated, untrusted)]: "say \\"hello\\""\n\n[Audio transcript (machine-generated, untrusted)]: "second clip"',
    );
    expect(runMediaUnderstandingFile).toHaveBeenNthCalledWith(1, {
      capability: "audio",
      kind: "audio",
      filePath: "/tmp/voice.ogg",
      cfg: allAudioConfig,
      agentId: "main",
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      mime: "audio/ogg",
      scopeContext: {
        sessionKey: "agent:main:telegram:group",
        channel: "telegram",
        chatType: "group",
      },
    });
    expect(runMediaUnderstandingFile).toHaveBeenNthCalledWith(2, {
      capability: "audio",
      kind: "audio",
      filePath: "/tmp/clip.mp3",
      cfg: allAudioConfig,
      agentId: "main",
      agentDir: "/tmp/agent",
      workspaceDir: "/tmp/workspace",
      mime: "audio/mpeg",
      scopeContext: {
        sessionKey: "agent:main:telegram:group",
        channel: "telegram",
        chatType: "group",
      },
    });
  });

  it("applies configured attachment ordering before invoking the file runtime", async () => {
    const runMediaUnderstandingFile = vi.fn(async ({ filePath }: { filePath: string }) => ({
      text: filePath,
    }));

    await expect(
      prepareCodexConversationAudioPrompt({
        prompt: "",
        event: audioEvent({
          media: [
            { path: "/tmp/first.ogg", kind: "audio" },
            { path: "/tmp/last.ogg", kind: "audio" },
          ],
        }),
        config: {
          tools: {
            media: { audio: { attachments: { mode: "first", prefer: "last" } } },
          },
        },
        runMediaUnderstandingFile,
        selectMediaAttachments,
      }),
    ).resolves.toBe('[Audio transcript (machine-generated, untrusted)]: "/tmp/last.ogg"');
    expect(runMediaUnderstandingFile).toHaveBeenCalledTimes(1);
    expect(runMediaUnderstandingFile).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "/tmp/last.ogg" }),
    );
  });

  it("does not transcribe an attachment already handled by channel preflight", async () => {
    const runMediaUnderstandingFile = vi.fn();

    await expect(
      prepareCodexConversationAudioPrompt({
        prompt: '[Audio transcript (machine-generated, untrusted)]: "already done"',
        event: audioEvent({
          transcript: "already done",
          media: [{ path: "/tmp/voice.ogg", kind: "audio", transcribed: true }],
        }),
        config,
        runMediaUnderstandingFile,
        selectMediaAttachments,
      }),
    ).resolves.toBe('[Audio transcript (machine-generated, untrusted)]: "already done"');
    expect(runMediaUnderstandingFile).not.toHaveBeenCalled();
  });

  it("uses canonical audio kind when staged media has a generic MIME type", async () => {
    const runMediaUnderstandingFile = vi.fn(async () => ({ text: "extensionless voice" }));

    await expect(
      prepareCodexConversationAudioPrompt({
        prompt: "",
        event: audioEvent({
          media: [
            {
              path: "/tmp/staged-voice",
              contentType: "application/octet-stream",
              kind: "audio",
            },
          ],
        }),
        config,
        runMediaUnderstandingFile,
        selectMediaAttachments,
      }),
    ).resolves.toBe('[Audio transcript (machine-generated, untrusted)]: "extensionless voice"');
    expect(runMediaUnderstandingFile).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "/tmp/staged-voice", mime: "application/octet-stream" }),
    );
  });

  it("keeps the original prompt when configured STT produces no transcript", async () => {
    const runMediaUnderstandingFile = vi.fn(async () => ({ text: undefined }));

    await expect(
      prepareCodexConversationAudioPrompt({
        prompt: "[media attached: /tmp/voice.ogg]",
        event: audioEvent(),
        config,
        runMediaUnderstandingFile,
        selectMediaAttachments,
      }),
    ).resolves.toBe("[media attached: /tmp/voice.ogg]");
  });
});
