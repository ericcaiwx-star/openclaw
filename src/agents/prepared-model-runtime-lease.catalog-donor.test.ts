import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PreparedModelRuntimeInput } from "./prepared-model-runtime.types.js";

const resolvePluginMetadataSnapshot = vi.hoisted(() => vi.fn());

vi.mock("../plugins/plugin-metadata-snapshot.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/plugin-metadata-snapshot.js")>(
    "../plugins/plugin-metadata-snapshot.js",
  );
  return {
    ...actual,
    resolvePluginMetadataSnapshot,
  };
});

const { preparedModelCatalogDonorMatches } = await import("./prepared-model-runtime-lease.js");

function runtimeInput(
  overrides: Partial<PreparedModelRuntimeInput> = {},
): PreparedModelRuntimeInput {
  return {
    agentId: "main",
    agentDir: "/tmp/agent",
    config: {},
    workspaceDir: "/tmp/workspace",
    ...overrides,
  };
}

function pluginSnapshot(plugins: Array<{ pluginId: string; origin: string; rootDir: string }>) {
  return {
    policyHash: "policy",
    index: {
      version: 1,
      hostContractVersion: 1,
      compatRegistryVersion: 1,
      migrationVersion: 1,
      policyHash: "policy",
      plugins: plugins.map((plugin) => ({
        ...plugin,
        manifestHash: plugin.pluginId,
        manifestPath: `${plugin.rootDir}/openclaw.plugin.json`,
        enabled: true,
      })),
    },
  };
}

describe("prepared model catalog donor isolation", () => {
  beforeEach(() => {
    resolvePluginMetadataSnapshot.mockReset();
  });

  it("shares a published catalog across directories when the effective plugin identity matches", () => {
    resolvePluginMetadataSnapshot.mockReturnValue(
      pluginSnapshot([
        { pluginId: "global-provider", origin: "global", rootDir: "/opt/global-provider" },
      ]),
    );

    expect(
      preparedModelCatalogDonorMatches(
        runtimeInput(),
        runtimeInput({ workspaceDir: "/tmp/outside" }),
      ),
    ).toBe(true);
    expect(resolvePluginMetadataSnapshot).toHaveBeenCalledTimes(2);
    expect(resolvePluginMetadataSnapshot).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ workspaceDir: "/tmp/workspace", allowCurrent: false }),
    );
    expect(resolvePluginMetadataSnapshot).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ workspaceDir: "/tmp/outside", allowCurrent: false }),
    );
    expect(resolvePluginMetadataSnapshot.mock.calls[0]?.[0]).not.toHaveProperty(
      "pluginMetadataSnapshot",
    );
  });

  it("refuses a workspace-only plugin that the outside directory does not admit", () => {
    resolvePluginMetadataSnapshot.mockImplementation((params: { workspaceDir?: string }) =>
      params.workspaceDir === "/tmp/workspace"
        ? pluginSnapshot([
            {
              pluginId: "workspace-only",
              origin: "workspace",
              rootDir: "/tmp/workspace/extensions/workspace-only",
            },
          ])
        : pluginSnapshot([]),
    );

    expect(
      preparedModelCatalogDonorMatches(
        runtimeInput(),
        runtimeInput({ workspaceDir: "/tmp/outside" }),
      ),
    ).toBe(false);
  });

  it("shares across directories when only the executed model selection differs", () => {
    resolvePluginMetadataSnapshot.mockReturnValue(
      pluginSnapshot([
        { pluginId: "global-provider", origin: "global", rootDir: "/opt/global-provider" },
      ]),
    );

    expect(
      preparedModelCatalogDonorMatches(
        runtimeInput({
          runtimePluginSelections: [{ provider: "proof-static", modelId: "static-marker" }],
        }),
        runtimeInput({
          workspaceDir: "/tmp/outside",
          runtimePluginSelections: [{ provider: "proof-discovery", modelId: "discovered-only" }],
        }),
      ),
    ).toBe(true);
  });

  it("refuses a different directory when agent or auth identity differs", () => {
    expect(
      preparedModelCatalogDonorMatches(
        runtimeInput(),
        runtimeInput({ workspaceDir: "/tmp/outside", agentDir: "/tmp/other-agent" }),
      ),
    ).toBe(false);
    expect(resolvePluginMetadataSnapshot).not.toHaveBeenCalled();
  });

  it("keeps same-directory catalog sharing when runtime selections differ", () => {
    expect(
      preparedModelCatalogDonorMatches(
        runtimeInput({ runtimePluginSelections: [{ provider: "openai", modelId: "gpt" }] }),
        runtimeInput({ runtimePluginSelections: [{ provider: "anthropic", modelId: "claude" }] }),
      ),
    ).toBe(true);
    expect(resolvePluginMetadataSnapshot).not.toHaveBeenCalled();
  });

  it("refuses the donor when plugin identity cannot be resolved", () => {
    resolvePluginMetadataSnapshot.mockImplementation(() => {
      throw new Error("plugin metadata unavailable");
    });

    expect(
      preparedModelCatalogDonorMatches(
        runtimeInput(),
        runtimeInput({ workspaceDir: "/tmp/outside" }),
      ),
    ).toBe(false);
  });
});
