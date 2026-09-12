import { isDeepStrictEqual } from "node:util";
import {
  findNormalizedProviderKey,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import {
  ensureAuthProfileStoreWithoutExternalProfiles,
  resolveAuthProfileOrder,
  resolvePersistedAuthProfileOwnerAgentDir,
} from "../../agents/auth-profiles.js";
import {
  listCandidateAuthProfileStores,
  loadCandidateAuthProfileStore,
} from "../../agents/auth-profiles/candidate-stores.js";
import { resolveSharedAuthStorePath } from "../../agents/auth-profiles/path-resolve.js";
import { upsertAuthProfileWithLockOrThrow } from "../../agents/auth-profiles/profiles.js";
import type { AuthProfileCredential } from "../../agents/auth-profiles/types.js";
import {
  resolveProviderConfigSecretInput,
  resolveProviderEntryApiKeyProfileReference,
} from "../../agents/model-auth-provider-config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolvePathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { applyAuthProfileConfig } from "../../plugins/provider-auth-helpers.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import {
  normalizeManualAuthProvider,
  resolveDefaultTokenProfileId,
  validateOpenAICodexApiKeyInput,
} from "./auth-manual-input.js";
import { loadValidConfigSnapshotOrThrow, updateConfig } from "./shared.js";

function resolveConfiguredApiKeyConnectionId(config: OpenClawConfig, provider: string) {
  const id = findNormalizedProviderKey(config.models?.providers, provider);
  const connection = id ? config.models?.providers?.[id] : undefined;
  if (connection?.auth && connection.auth !== "api-key") {
    throw new Error("This connection uses another sign-in method. Use its sign-in option instead.");
  }
  return id;
}

function resolveConfiguredApiKeyBinding(config: OpenClawConfig, providerId: string) {
  const { providerConfig, ref } = resolveProviderConfigSecretInput(config, providerId);
  return ref ?? providerConfig?.apiKey;
}

export async function resolveModelProviderApiKeySavePlan(params: {
  config: OpenClawConfig;
  provider: string;
  profileId?: string;
  agentDir: string;
}) {
  const provider = normalizeManualAuthProvider(params.provider);
  const validateCurrentCredential = (existing: AuthProfileCredential | undefined) => {
    if (existing?.type === "api_key" && existing.keyRef) {
      throw new Error(
        "This API-key profile uses an external secret reference. Remove that saved sign-in before storing an inline key.",
      );
    }
    if (
      existing &&
      (existing.type !== "api_key" || normalizeProviderId(existing.provider) !== provider)
    ) {
      throw new Error(
        "The API-key profile belongs to another sign-in. Manage that saved sign-in first, or use --profile-id with a distinct profile ID.",
      );
    }
  };
  const connectionId = params.profileId
    ? undefined
    : resolveConfiguredApiKeyConnectionId(params.config, provider);
  const connectionBinding = connectionId
    ? resolveConfiguredApiKeyBinding(params.config, connectionId)
    : undefined;
  const store = ensureAuthProfileStoreWithoutExternalProfiles(params.agentDir);
  const replacementId = !connectionId
    ? resolveAuthProfileOrder({ cfg: params.config, store, provider }).find((id) => {
        const credential = store.profiles[id];
        return credential?.type === "api_key" && !credential.keyRef;
      })
    : undefined;
  const configuredReference = connectionId
    ? resolveProviderEntryApiKeyProfileReference({
        cfg: params.config,
        provider: connectionId,
        store,
      })
    : undefined;
  const configuredProfileId =
    configuredReference?.kind === "profile" || configuredReference?.kind === "profile-incompatible"
      ? configuredReference.profileId
      : undefined;
  const profileId =
    params.profileId ??
    configuredProfileId ??
    replacementId ??
    resolveDefaultTokenProfileId(provider);
  if (isUserModelAuthProfileId(profileId)) {
    throw new Error(
      "Personal model accounts are managed in Settings → Profile → Connected accounts.",
    );
  }
  const agentDir = connectionId
    ? undefined
    : store.profiles[profileId]
      ? resolvePersistedAuthProfileOwnerAgentDir({ agentDir: params.agentDir, profileId })
      : params.agentDir;
  const localCandidates = connectionId
    ? (await listCandidateAuthProfileStores({ cfg: params.config })).filter(
        (candidate) =>
          candidate.databasePath !==
          resolvePathViaExistingAncestorSync(resolveSharedAuthStorePath()),
      )
    : [];
  const validateSharedBinding = () => {
    if (
      localCandidates.some(
        (candidate) => loadCandidateAuthProfileStore(candidate)?.profiles[profileId],
      )
    ) {
      throw new Error(
        "An agent already overrides this shared key. Remove that agent's override before replacing the shared key.",
      );
    }
  };
  const validateReplacement = (existing: AuthProfileCredential | undefined) => {
    validateCurrentCredential(existing);
    validateSharedBinding();
  };
  // Validate the effective inherited profile before choosing its physical owner.
  // The locked callback repeats this against the destination store for races.
  validateReplacement(store.profiles[profileId]);
  return {
    provider,
    profileId,
    agentDir,
    connectionId,
    connectionBinding,
    validateCurrentCredential: validateReplacement,
    validateSharedBinding,
  };
}

export async function applyModelProviderApiKeyConnectionBinding(
  plan: Awaited<ReturnType<typeof resolveModelProviderApiKeySavePlan>>,
): Promise<void> {
  const connectionId = plan.connectionId;
  if (!connectionId || isDeepStrictEqual(plan.connectionBinding, plan.profileId)) {
    return;
  }
  await updateConfig((current) => {
    const id = resolveConfiguredApiKeyConnectionId(current, plan.provider);
    if (
      id !== connectionId ||
      (id !== undefined &&
        !isDeepStrictEqual(resolveConfiguredApiKeyBinding(current, id), plan.connectionBinding))
    ) {
      throw new Error(
        "The provider connection changed during the key update. Reopen the connection and save the key again",
      );
    }
    plan.validateSharedBinding();
    const connection = current.models?.providers?.[connectionId];
    if (!connection) {
      throw new Error(
        "The provider connection changed during the key update. Reopen the connection and save the key again",
      );
    }
    return {
      ...current,
      models: {
        ...current.models,
        providers: {
          ...current.models?.providers,
          [connectionId]: { ...connection, apiKey: plan.profileId },
        },
      },
    };
  }).catch((error: unknown) => {
    throw new Error(
      "API key saved, but provider settings could not be applied: " +
        (error instanceof Error ? error.message : String(error)) +
        ". Reopen Models and save the key again.",
      { cause: error },
    );
  });
}

/** Saves a manual key without changing model selection or connection settings. */
export async function saveModelProviderApiKey(params: {
  config?: OpenClawConfig;
  provider: string;
  apiKey: string;
  profileId?: string;
  agentDir: string;
}): Promise<string> {
  const provider = normalizeManualAuthProvider(params.provider);
  const key = normalizeSecretInput(params.apiKey);
  registerSecretValueForRedaction(key);
  const validationError = !key
    ? "API key is required"
    : provider === "openai"
      ? validateOpenAICodexApiKeyInput(key)
      : undefined;
  if (validationError) {
    throw new Error(validationError);
  }
  const config = params.config ?? (await loadValidConfigSnapshotOrThrow()).runtimeConfig;
  const plan = await resolveModelProviderApiKeySavePlan({
    config,
    provider,
    profileId: params.profileId,
    agentDir: params.agentDir,
  });
  await upsertAuthProfileWithLockOrThrow({
    profileId: plan.profileId,
    credential: { type: "api_key", provider, key },
    agentDir: plan.agentDir,
    preserveApiKeyMetadata: true,
    validateCurrentCredential: plan.validateCurrentCredential,
  });
  await updateConfig((current) => {
    const id = params.profileId
      ? undefined
      : resolveConfiguredApiKeyConnectionId(current, provider);
    if (
      !params.profileId &&
      (id !== plan.connectionId ||
        (id !== undefined &&
          !isDeepStrictEqual(resolveConfiguredApiKeyBinding(current, id), plan.connectionBinding)))
    ) {
      throw new Error(
        "The provider connection changed during the key update. Reopen the connection and save the key again",
      );
    }
    plan.validateSharedBinding();
    const next = applyAuthProfileConfig(current, {
      ...current.auth?.profiles?.[plan.profileId],
      profileId: plan.profileId,
      provider,
      mode: "api_key",
    });
    if (!id || !next.models?.providers?.[id]) {
      return next;
    }
    return {
      ...next,
      models: {
        ...next.models,
        providers: {
          ...next.models.providers,
          [id]: { ...next.models.providers[id], apiKey: plan.profileId },
        },
      },
    };
  }).catch((error: unknown) => {
    throw new Error(
      "API key saved, but provider settings could not be applied: " +
        (error instanceof Error ? error.message : String(error)) +
        ". Reopen Models and save the key again.",
      { cause: error },
    );
  });
  return plan.profileId;
}
