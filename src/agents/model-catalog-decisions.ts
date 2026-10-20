import {
  withCurrentReadAuthority,
  type CurrentReadAuthority,
} from "../shared/current-read-authority.js";
import { getActiveOpenClawStateDatabaseReadSnapshot } from "../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateReadWorkerContext } from "../state/openclaw-state-worker-context.js";
import { isUserModelAuthProfileId } from "../state/user-model-account-id.js";
import type { PersonalCatalogSelection } from "../state/user-model-accounts.js";
import { captureUserProfileModelAccountLinksAuthority } from "../state/user-profile-events.js";
import {
  createModelCatalogDecisions,
  type ModelCatalogDecisionParams,
} from "./model-catalog-decisions.projection.js";
import { PreparedModelRuntimePublicationSupersededError } from "./prepared-model-runtime.errors.js";

export { createModelCatalogDecisions, type ModelCatalogDecisionParams };
export { resolveCatalogDecisionRuntime } from "./model-catalog-decision-runtime.js";

/** Prepare private records once under the caller's retained credential authority. */
export async function prepareModelCatalogDecisions(
  params: ModelCatalogDecisionParams,
  authority?: CurrentReadAuthority,
) {
  const selection: PersonalCatalogSelection | undefined =
    params.preferredProfileId && isUserModelAuthProfileId(params.preferredProfileId)
      ? { profileId: params.preferredProfileId }
      : !params.preferredProfileId && params.requesterProfileId
        ? { requesterProfileId: params.requesterProfileId }
        : undefined;
  if (!selection || params.preparedPersonalCatalog) {
    return withCurrentReadAuthority(authority, () => createModelCatalogDecisions(params));
  }
  const context = captureOpenClawStateReadWorkerContext();
  const linksAreCurrent =
    "requesterProfileId" in selection
      ? captureUserProfileModelAccountLinksAuthority(
          context.admission,
          selection.requesterProfileId,
        )
      : undefined;
  const isCurrent = () => {
    try {
      context.admission.assertCurrent();
      return linksAreCurrent?.() !== false;
    } catch {
      return false;
    }
  };
  const assertPreparedCurrent = () => {
    if (!isCurrent() || params.isCurrent?.() === false) {
      throw new PreparedModelRuntimePublicationSupersededError(
        "Personal model accounts changed while preparing the catalog",
      );
    }
  };
  const { readPersonalCatalogProfiles } = await import("./auth-profiles/sqlite-read.js");
  const profiles = await withCurrentReadAuthority(authority, () => {
    assertPreparedCurrent();
    if ("requesterProfileId" in selection && getActiveOpenClawStateDatabaseReadSnapshot()) {
      throw new PreparedModelRuntimePublicationSupersededError(
        "Default account selection requires current link authority",
      );
    }
    return readPersonalCatalogProfiles(selection, context);
  });
  return withCurrentReadAuthority(authority, () => {
    assertPreparedCurrent();
    return createModelCatalogDecisions({
      ...params,
      preparedPersonalCatalog: { ...profiles, isCurrent },
    });
  });
}
