import { describe, it, expect, vi } from "vitest";
import { ReplacedContainerCleanupService } from "@src/services/replaced-container-cleanup-service.mjs";
import type { ContextManager } from "@src/context-manager.mjs";

// destroyContainers() loops the existing per-container destroy primitive over an
// explicit vmId list and accumulates destroyed/failed. We stub the private
// destroyForContext so the test is deterministic (no scripts / SSH), and verify
// the accumulation + partial-failure behavior the installations-cleanup button
// relies on.
function makeService(): ReplacedContainerCleanupService {
  // destroyForContext is stubbed per-test, so the ContextManager is never
  // actually reached — a bare stub is enough.
  return new ReplacedContainerCleanupService({} as ContextManager);
}

describe("ReplacedContainerCleanupService.destroyContainers", () => {
  it("destroys every vmId and reports them as destroyed", async () => {
    const svc = makeService();
    const destroySpy = vi
      .spyOn(svc as unknown as { destroyForContext: (k: string, v: number) => Promise<void> }, "destroyForContext")
      .mockResolvedValue(undefined);

    const result = await svc.destroyContainers("ve_pve1.cluster", [101, 102]);

    expect(destroySpy).toHaveBeenCalledTimes(2);
    expect(destroySpy).toHaveBeenNthCalledWith(1, "ve_pve1.cluster", 101);
    expect(destroySpy).toHaveBeenNthCalledWith(2, "ve_pve1.cluster", 102);
    expect(result.destroyed).toEqual(["101@pve1.cluster", "102@pve1.cluster"]);
    expect(result.failed).toEqual([]);
  });

  it("continues after a failure and records it in failed[]", async () => {
    const svc = makeService();
    vi.spyOn(
      svc as unknown as { destroyForContext: (k: string, v: number) => Promise<void> },
      "destroyForContext",
    ).mockImplementation(async (_key: string, vmId: number) => {
      if (vmId === 102) throw new Error("pct destroy failed");
    });

    const result = await svc.destroyContainers("ve_pve1.cluster", [101, 102, 103]);

    expect(result.destroyed).toEqual(["101@pve1.cluster", "103@pve1.cluster"]);
    expect(result.failed).toEqual([
      { vmid: 102, ve_host: "pve1.cluster", error: "pct destroy failed" },
    ]);
  });

  it("returns empty result for an empty vmId list without calling destroy", async () => {
    const svc = makeService();
    const destroySpy = vi
      .spyOn(svc as unknown as { destroyForContext: (k: string, v: number) => Promise<void> }, "destroyForContext")
      .mockResolvedValue(undefined);

    const result = await svc.destroyContainers("ve_pve1.cluster", []);

    expect(destroySpy).not.toHaveBeenCalled();
    expect(result).toEqual({ destroyed: [], failed: [] });
  });
});
