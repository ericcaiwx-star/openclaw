import {
  copyRestoredAgentMessageOrigin,
  markRestoredAgentMessage,
} from "../../../packages/agent-core/src/internal-hooks.js";
import type { AgentMessage } from "../../../packages/agent-core/src/types.js";
import type { FileEntry, SessionEntry } from "./session-manager-types.js";

/** Admission reconstructs history provenance after worker copies; it never chooses a key. */
export function markRestoredSessionMessages(entries: readonly FileEntry[]): void {
  for (const entry of entries) {
    if (entry.type === "message") {
      markRestoredAgentMessage(entry.message);
    }
  }
}

/** Consume accepted context lazily without retaining its iterator beyond the source owner. */
export function* restoredContextMessages(
  messages: Iterable<AgentMessage>,
): Generator<AgentMessage> {
  for (const message of messages) {
    markRestoredAgentMessage(message);
    yield message;
  }
}

/** Transfer only across the exact view clone made by transcript rewrite preparation. */
export function copyRestoredSessionMessageOrigins(
  entries: readonly FileEntry[],
  sourceEntries: ReadonlyMap<string, SessionEntry>,
): void {
  for (const entry of entries) {
    const original = entry.type === "message" ? sourceEntries.get(entry.id) : undefined;
    if (entry.type === "message" && original?.type === "message") {
      copyRestoredAgentMessageOrigin(original.message, entry.message);
    }
  }
}
