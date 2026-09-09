// Codex plugin module prepares bound-conversation audio for configured transcription.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  RunMediaUnderstandingFileParams,
  RunMediaUnderstandingFileResult,
} from "openclaw/plugin-sdk/media-understanding-runtime";
import type { PluginHookInboundClaimEvent } from "openclaw/plugin-sdk/plugin-entry";
import { listCodexConversationAudioForTranscription } from "./conversation-turn-input.js";

type RunMediaUnderstandingFile = (
  params: RunMediaUnderstandingFileParams,
) => Promise<RunMediaUnderstandingFileResult>;

export async function prepareCodexConversationAudioPrompt(params: {
  prompt: string;
  event: PluginHookInboundClaimEvent;
  config?: OpenClawConfig;
  agentId?: string;
  agentDir?: string;
  workspaceDir?: string;
  sessionKey?: string;
  runMediaUnderstandingFile?: RunMediaUnderstandingFile;
}): Promise<string> {
  if (!params.config || !params.runMediaUnderstandingFile) {
    return params.prompt;
  }
  const audioAttachments = listCodexConversationAudioForTranscription(params.event);
  if (audioAttachments.length === 0) {
    return params.prompt;
  }
  const transcripts: string[] = [];
  for (const audio of audioAttachments) {
    const result = await params.runMediaUnderstandingFile({
      capability: "audio",
      filePath: audio.filePath,
      ...(audio.mediaUrl ? { mediaUrl: audio.mediaUrl } : {}),
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
  // Keep media-understanding runtime out of the Codex registration import closure.
  const { formatAudioTranscriptForAgent } =
    await import("openclaw/plugin-sdk/media-understanding-runtime");
  const transcriptPrompts = transcripts.map(formatAudioTranscriptForAgent);
  return [params.prompt, ...transcriptPrompts].filter(Boolean).join("\n\n");
}
