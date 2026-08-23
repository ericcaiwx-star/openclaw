// Removes leftover global paste metadata that only a secondary agent can resolve.
import path from "node:path";
import {
  listAgentIds,
  resolveAgentDir,
  resolveDefaultAgentDir,
} from "../../../agents/agent-scope.js";
import {
  loadPersistedAuthProfileStore,
  loadPersistedSharedAuthProfileStore,
} from "../../../agents/auth-profiles/persisted.js";
import { resolveSharedMainAuthAgentDir } from "../../../agents/auth-profiles/shared-main-dir.js";
import type { AuthProfileStore } from "../../../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { HealthFinding } from "../../../flows/health-checks.js";
import { isRecord } from "../../../utils.js";
import { listAuthProfileRepairCandidates } from "../../doctor-auth-legacy-paths.js";

const CHECK_ID = "core/doctor/auth-stale-global-paste";

type StaleGlobalPasteProfile = {
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

function hasPasteCredential(store: AuthProfileStore | null, profileId: string): boolean {
  const credential = store?.profiles[profileId];
  if (credential?.type === "api_key") {
    return Boolean(credential.key || credential.keyRef);
  }
  if (credential?.type === "token") {
    return Boolean(credential.token || credential.tokenRef);
  }
  return false;
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

/** Portable config metadata whose secret exists only on a non-default agent. */
function findStaleGlobalPasteDeclarations(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): StaleGlobalPasteProfile[] {
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
        if (hasPasteCredential(store, profileId)) {
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
      if (!hasPasteCredential(store, profileId)) {
        continue;
      }
      const existing = secondaryHits.get(profileId) ?? [];
      if (!existing.includes(agentLabel)) {
        existing.push(agentLabel);
        secondaryHits.set(profileId, existing);
      }
    }
  }

  const hits: StaleGlobalPasteProfile[] = [];
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

function removeProfileDeclaration(cfg: OpenClawConfig, profileId: string): OpenClawConfig {
  const profiles = { ...cfg.auth?.profiles };
  delete profiles[profileId];
  const orderEntries = Object.entries(cfg.auth?.order ?? {}).flatMap(([provider, ids]) => {
    if (!Array.isArray(ids)) {
      return [];
    }
    const next = ids.filter((id) => id !== profileId);
    return next.length > 0 ? [[provider, next] as const] : [];
  });
  const auth: NonNullable<OpenClawConfig["auth"]> = { ...cfg.auth };
  if (Object.keys(profiles).length > 0) {
    auth.profiles = profiles;
  } else {
    delete auth.profiles;
  }
  if (orderEntries.length > 0) {
    auth.order = Object.fromEntries(orderEntries);
  } else {
    delete auth.order;
  }
  if (!auth.profiles && !auth.order) {
    const next = { ...cfg };
    delete next.auth;
    return next;
  }
  return { ...cfg, auth };
}

/** Drop demonstrably stale global paste declarations; leave unproven routes alone. */
export function maybeRepairStaleGlobalPasteProfiles(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): { config: OpenClawConfig; changes: string[] } {
  const hits = findStaleGlobalPasteDeclarations(params);
  if (hits.length === 0) {
    return { config: params.cfg, changes: [] };
  }
  let config = params.cfg;
  const changes: string[] = [];
  for (const hit of hits) {
    config = removeProfileDeclaration(config, hit.profileId);
    changes.push(
      `auth.profiles.${hit.profileId}: removed leftover ${hit.mode} metadata (credential lives only on agent ${hit.foundInAgents.join(", ")}).`,
    );
  }
  return { config, changes };
}

/** Doctor detect findings for leftover secondary-agent paste metadata. */
export function collectStaleGlobalPasteFindings(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  doctorFixCommand?: string;
}): HealthFinding[] {
  const fix = params.doctorFixCommand ?? "openclaw doctor --fix";
  return findStaleGlobalPasteDeclarations(params).map((hit) => ({
    checkId: CHECK_ID,
    severity: "warning",
    message: `auth.profiles.${hit.profileId} is leftover secondary-agent ${hit.mode} metadata; the default agent cannot resolve it.`,
    target: hit.profileId,
    fixHint: `Run \`${fix}\` to drop this global declaration. The credential stays in agent ${hit.foundInAgents.join(", ")}.`,
  }));
}
