// Codex plugin module prepares bound-conversation audio for configured transcription.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  RunMediaUnderstandingFileParams,
  RunMediaUnderstandingFileResult,
} from "openclaw/plugin-sdk/media-understanding-runtime";
import type { PluginHookInboundClaimEvent } from "openclaw/plugin-sdk/plugin-entry";
import {
  listCodexConversationAudioAttachments,
  type CodexConversationAudioAttachment,
} from "./conversation-turn-input.js";

type RunMediaUnderstandingFile = (
  params: RunMediaUnderstandingFileParams,
) => Promise<RunMediaUnderstandingFileResult>;

type SelectMediaAttachments = (params: {
  capability: "audio";
  attachments: CodexConversationAudioAttachment[];
  policy?: {
    mode?: "first" | "all";
    maxAttachments?: number;
    prefer?: "first" | "last" | "path" | "url";
  };
}) => Promise<{
  selected: CodexConversationAudioAttachment[];
  droppedAttachmentIndexes: number[];
}>;

export async function prepareCodexConversationAudioPrompt(params: {
  prompt: string;
  event: PluginHookInboundClaimEvent;
  config?: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  sessionKey?: string;
  runMediaUnderstandingFile?: RunMediaUnderstandingFile;
  selectMediaAttachments?: SelectMediaAttachments;
}): Promise<string> {
  if (!params.config || !params.runMediaUnderstandingFile || !params.selectMediaAttachments) {
    return params.prompt;
  }
  const audioAttachments = listCodexConversationAudioAttachments(params.event);
  if (audioAttachments.length === 0) {
    return params.prompt;
  }
  // Use the same selector as normal channel media understanding so configured
  // first/all, ordering preference, and max-count behavior remain identical.
  const selectedAudio = (
    await params.selectMediaAttachments({
      capability: "audio",
      attachments: audioAttachments,
      policy: params.config.tools?.media?.audio?.attachments,
    })
  ).selected;
  const transcripts: string[] = [];
  for (const audio of selectedAudio) {
    const filePath = audio.path ?? audio.url;
    if (!filePath) {
      continue;
    }
    const result = await params.runMediaUnderstandingFile({
      capability: "audio",
      kind: "audio",
      filePath,
      ...(!audio.path && audio.url ? { mediaUrl: audio.url } : {}),
      cfg: params.config,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.agentDir ? { agentDir: params.agentDir } : {}),
      ...((audio.workspaceDir ?? params.workspaceDir)
        ? { workspaceDir: audio.workspaceDir ?? params.workspaceDir }
        : {}),
      ...(audio.mime ? { mime: audio.mime } : {}),
      scopeContext: {
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        channel: params.event.channel,
        chatType: params.event.isGroup ? "group" : "direct",
      },
    });
    const transcript = result.text?.trim();
    if (transcript) {
      transcripts.push(transcript);
    }
  }
  if (transcripts.length === 0) {
    return params.prompt;
  }
  const { formatAudioTranscriptForAgent } =
    await import("openclaw/plugin-sdk/media-understanding-runtime");
  const transcriptPrompts = transcripts.map(formatAudioTranscriptForAgent);
  return [params.prompt, ...transcriptPrompts].filter(Boolean).join("\n\n");
}
