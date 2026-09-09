// File-runtime audio kind tests cover capability preservation before attachment selection.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { runMediaUnderstandingFile } from "./runtime.js";
import type { MediaAttachment } from "./types.js";

const mocks = vi.hoisted(() => ({
  normalizeMediaAttachments: vi.fn<() => MediaAttachment[]>(),
  runCapability: vi.fn(),
  cleanup: vi.fn(async () => {}),
}));

vi.mock("./runner.js", () => ({
  buildProviderRegistry: vi.fn(() => new Map()),
  createMediaAttachmentCache: vi.fn(() => ({ cleanup: mocks.cleanup })),
  normalizeMediaAttachments: mocks.normalizeMediaAttachments,
  runCapability: mocks.runCapability,
}));

describe("media-understanding file runtime audio kind", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves the requested capability for an extensionless generic-MIME file", async () => {
    const media = [
      {
        index: 0,
        path: "/tmp/staged-voice",
        mime: "application/octet-stream",
        kind: "audio" as const,
      },
    ];
    mocks.normalizeMediaAttachments.mockReturnValue(media);
    mocks.runCapability.mockResolvedValue({
      outputs: [],
      decision: { capability: "audio", outcome: "skipped", attachments: [] },
    });

    await runMediaUnderstandingFile({
      capability: "audio",
      filePath: "/tmp/staged-voice",
      mime: "application/octet-stream",
      cfg: {} as OpenClawConfig,
      agentDir: "/tmp/agent",
    });

    expect(mocks.normalizeMediaAttachments).toHaveBeenCalledWith({
      media: [
        {
          path: "/tmp/staged-voice",
          contentType: "application/octet-stream",
          kind: "audio",
        },
      ],
    });
    expect(mocks.runCapability).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "audio", media }),
    );
    expect(mocks.cleanup).toHaveBeenCalledOnce();
  });

  it("preserves an authoritative remote audio kind over a conflicting URL extension", async () => {
    const media = [
      {
        index: 0,
        url: "https://example.test/voice.webm",
        mime: "application/octet-stream",
        kind: "audio" as const,
      },
    ];
    mocks.normalizeMediaAttachments.mockReturnValue(media);
    mocks.runCapability.mockResolvedValue({
      outputs: [],
      decision: { capability: "audio", outcome: "skipped", attachments: [] },
    });

    await runMediaUnderstandingFile({
      capability: "audio",
      kind: "audio",
      filePath: "https://example.test/voice.webm",
      mediaUrl: "https://example.test/voice.webm",
      mime: "application/octet-stream",
      cfg: {} as OpenClawConfig,
      agentDir: "/tmp/agent",
    });

    expect(mocks.normalizeMediaAttachments).toHaveBeenCalledWith({
      media: [
        {
          url: "https://example.test/voice.webm",
          contentType: "application/octet-stream",
          kind: "audio",
        },
      ],
    });
    expect(mocks.runCapability).toHaveBeenCalledWith(
      expect.objectContaining({ capability: "audio", media }),
    );
  });
});
