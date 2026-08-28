// Diagnose global auth.profiles that only a secondary agent can resolve.
// Doctor never deletes them: a secondary-only secret is not proof the
// declaration came from an old paste. An operator can intend that order.
import path from "node:path";
import {
  listAgentIds,
  resolveAgentDir,
  resolveDefaultAgentDir,
} from "../../../agents/agent-scope.js";
import { evaluateStoredCredentialEligibility } from "../../../agents/auth-profiles/credential-state.js";
import {
  loadPersistedAuthProfileStore,
  loadPersistedSharedAuthProfileStore,
} from "../../../agents/auth-profiles/persisted.js";
import { isAuthProfileConfigCompatible } from "../../../agents/auth-profiles/profile-config-compat.js";
import { resolveSharedMainAuthAgentDir } from "../../../agents/auth-profiles/shared-main-dir.js";
import type { AuthProfileStore } from "../../../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { HealthFinding } from "../../../flows/health-checks.js";
import { isRecord } from "../../../utils.js";
import { listAuthProfileRepairCandidates } from "../../doctor-auth-legacy-paths.js";

const CHECK_ID = "core/doctor/auth-stale-global-paste";

type UnresolvedSecondaryOnlyGlobalProfile = {
  profileId: string;
  provider: string;
  mode: "api_key" | "token";
  foundInAgents: string[];
};

function readPasteProfile(value: unknown): {
  provider: string;
  mode: "api_key" | "token";
} | null {
  if (!isRecord(value) || typeof value.provider !== "string") {
    return null;
  }
  if (value.mode !== "api_key" && value.mode !== "token") {
    return null;
  }
  return { provider: value.provider, mode: value.mode };
}

function hasPasteCredential(
  store: AuthProfileStore | null,
  profileId: string,
  cfg: OpenClawConfig,
): boolean {
  const credential = store?.profiles[profileId];
  if (credential?.type !== "api_key" && credential?.type !== "token") {
    return false;
  }
  if (!evaluateStoredCredentialEligibility({ credential }).eligible) {
    return false;
  }
  return isAuthProfileConfigCompatible({
    cfg,
    profileId,
    provider: credential.provider,
    mode: credential.type,
  });
}

function loadCandidateStore(
  agentDir: string | undefined,
  env: NodeJS.ProcessEnv,
): AuthProfileStore | null {
  return agentDir === undefined
    ? loadPersistedSharedAuthProfileStore(env)
    : loadPersistedAuthProfileStore(agentDir);
}

function isDefaultResolutionDir(
  agentDir: string | undefined,
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): boolean {
  if (agentDir === undefined) {
    return true;
  }
  const resolved = path.resolve(agentDir);
  return (
    resolved === path.resolve(resolveSharedMainAuthAgentDir(env)) ||
    resolved === path.resolve(resolveDefaultAgentDir(cfg, env))
  );
}

function labelAgentDir(cfg: OpenClawConfig, env: NodeJS.ProcessEnv, agentDir: string): string {
  const resolved = path.resolve(agentDir);
  for (const agentId of listAgentIds(cfg)) {
    if (path.resolve(resolveAgentDir(cfg, agentId, env)) === resolved) {
      return agentId;
    }
  }
  return path.basename(path.dirname(agentDir)) || agentDir;
}

function findUnresolvedSecondaryOnlyGlobalProfiles(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): UnresolvedSecondaryOnlyGlobalProfile[] {
  const env = params.env ?? process.env;
  const profiles = params.cfg.auth?.profiles;
  if (!isRecord(profiles) || Object.keys(profiles).length === 0) {
    return [];
  }

  const candidates = listAuthProfileRepairCandidates(params.cfg, env);
  const defaultHas = new Set<string>();
  const secondaryHits = new Map<string, string[]>();
  for (const candidate of candidates) {
    const store = loadCandidateStore(candidate.agentDir, env);
    if (!store) {
      continue;
    }
    if (isDefaultResolutionDir(candidate.agentDir, params.cfg, env)) {
      for (const profileId of Object.keys(profiles)) {
        if (hasPasteCredential(store, profileId, params.cfg)) {
          defaultHas.add(profileId);
        }
      }
      continue;
    }
    if (!candidate.agentDir) {
      continue;
    }
    const agentLabel = labelAgentDir(params.cfg, env, candidate.agentDir);
    for (const profileId of Object.keys(profiles)) {
      if (!hasPasteCredential(store, profileId, params.cfg)) {
        continue;
      }
      const existing = secondaryHits.get(profileId) ?? [];
      if (!existing.includes(agentLabel)) {
        existing.push(agentLabel);
        secondaryHits.set(profileId, existing);
      }
    }
  }

  const hits: UnresolvedSecondaryOnlyGlobalProfile[] = [];
  for (const [profileId, profile] of Object.entries(profiles)) {
    const paste = readPasteProfile(profile);
    if (!paste || defaultHas.has(profileId)) {
      continue;
    }
    const foundInAgents = secondaryHits.get(profileId);
    if (!foundInAgents || foundInAgents.length === 0) {
      continue;
    }
    hits.push({
      profileId,
      provider: paste.provider,
      mode: paste.mode,
      foundInAgents,
    });
  }
  return hits;
}

/** Doctor detect findings for globally declared profiles only a secondary agent can resolve. */
export function collectStaleGlobalPasteFindings(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): HealthFinding[] {
  return findUnresolvedSecondaryOnlyGlobalProfiles(params).map((hit) => ({
    checkId: CHECK_ID,
    severity: "warning",
    message: `auth.profiles.${hit.profileId} is declared globally, but only agent ${hit.foundInAgents.join(", ")} has a usable ${hit.mode}; the default agent cannot resolve it.`,
    target: hit.profileId,
    fixHint:
      "Leave the declaration if it is intentional. To give the default agent this profile, paste the credential into that agent. Doctor --fix will not delete global auth.profiles or auth.order from this warning.",
  }));
}
