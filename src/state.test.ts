import { describe, it, expect, vi } from "vitest";
import { FolderState } from "./state";

describe("FolderState", () => {
  it("returns undefined for an unknown folder path", () => {
    const state = new FolderState({}, vi.fn());
    expect(state.getFolderPageId("Projects/2026")).toBeUndefined();
  });

  it("returns the id after setFolderPageId", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const state = new FolderState({}, save);
    await state.setFolderPageId("Projects/2026", "12345");
    expect(state.getFolderPageId("Projects/2026")).toBe("12345");
  });

  it("invokes the save callback with the updated record", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const state = new FolderState({}, save);
    await state.setFolderPageId("a", "1");
    expect(save).toHaveBeenLastCalledWith({ a: "1" });
    await state.setFolderPageId("b", "2");
    expect(save).toHaveBeenLastCalledWith({ a: "1", b: "2" });
  });

  it("round-trips via toJSON", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const state = new FolderState({}, save);
    await state.setFolderPageId("a", "1");
    const json = state.toJSON();
    const next = new FolderState(json, vi.fn());
    expect(next.getFolderPageId("a")).toBe("1");
  });

  it("survives JSON.stringify round-trip", async () => {
    const state = new FolderState({}, vi.fn().mockResolvedValue(undefined));
    await state.setFolderPageId("a/b", "999");
    const wire = JSON.parse(JSON.stringify(state.toJSON())) as Record<string, string>;
    const restored = new FolderState(wire, vi.fn());
    expect(restored.getFolderPageId("a/b")).toBe("999");
  });

  it("setFolderPageId overwrites previous value", async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const state = new FolderState({ a: "1" }, save);
    await state.setFolderPageId("a", "2");
    expect(state.getFolderPageId("a")).toBe("2");
  });
});
