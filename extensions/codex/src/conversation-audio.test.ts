// Codex tests cover configured transcription for conversation-bound audio.
import { describe, expect, it, vi } from "vitest";
import { prepareCodexConversationAudioPrompt } from "./conversation-audio.js";

const config = { tools: { media: { audio: { enabled: true } } } };

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
        config,
        agentId: "main",
        agentDir: "/tmp/agent",
        workspaceDir: "/tmp/workspace",
        sessionKey: "agent:main:telegram:group",
        runMediaUnderstandingFile,
      }),
    ).resolves.toBe(
      'Please summarize this.\n\n[Audio transcript (machine-generated, untrusted)]: "say \\"hello\\""\n\n[Audio transcript (machine-generated, untrusted)]: "second clip"',
    );
    expect(runMediaUnderstandingFile).toHaveBeenNthCalledWith(1, {
      capability: "audio",
      filePath: "/tmp/voice.ogg",
      cfg: config,
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
      filePath: "/tmp/clip.mp3",
      cfg: config,
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
      }),
    ).resolves.toBe("[media attached: /tmp/voice.ogg]");
  });
});
