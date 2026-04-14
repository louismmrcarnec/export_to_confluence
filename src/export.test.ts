import { describe, it, expect, vi, beforeEach } from "vitest";
import { TFile } from "obsidian";
import { exportNote } from "./export";
import { ConfluenceClient, PageMissingError, PageExistsError } from "./confluence";

// ---- helpers ---------------------------------------------------------

function makeTFile(name: string, path = `Notes/${name}`): TFile {
  const f = new TFile();
  f.name = name;
  f.path = path;
  f.basename = name.replace(/\.[^.]+$/, "");
  f.extension = name.split(".").pop() ?? "md";
  return f;
}

function makeImageFile(name: string): TFile {
  return makeTFile(name, `attachments/${name}`);
}

function makeApp(opts: {
  readContent?: string;
  readBinaryMap?: Record<string, Uint8Array>;
  resolveMap?: Record<string, TFile | null>;
}) {
  const { readContent = "", readBinaryMap = {}, resolveMap = {} } = opts;
  return {
    vault: {
      cachedRead: vi.fn().mockResolvedValue(readContent),
      readBinary: vi.fn((f: TFile) =>
        Promise.resolve(readBinaryMap[f.name]?.buffer ?? new ArrayBuffer(0)),
      ),
    },
    metadataCache: {
      getFirstLinkpathDest: vi.fn((lp: string) => resolveMap[lp] ?? null),
    },
  };
}

function makeClient(overrides: Partial<Record<keyof ConfluenceClient, unknown>> = {}): ConfluenceClient {
  return {
    createPage: vi.fn().mockResolvedValue("111"),
    updatePage: vi.fn().mockResolvedValue("222"),
    listAttachments: vi.fn().mockResolvedValue([]),
    uploadAttachment: vi.fn().mockResolvedValue(undefined),
    // Default: title matches "T" (the title used by most tests) → update path taken.
    getPageTitle: vi.fn().mockResolvedValue("T"),
    getPageByTitle: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as ConfluenceClient;
}

const NOTE = makeTFile("my-note.md");

// ---- tests -----------------------------------------------------------

describe("exportNote — create path (no existing page id)", () => {
  it("creates the page, uploads images, then updates with rewritten HTML", async () => {
    const imgFile = makeImageFile("shot.png");
    const imgBytes = new Uint8Array(1200).fill(0xab);
    const client = makeClient({ createPage: vi.fn().mockResolvedValue("111") });
    const app = makeApp({
      readContent: "---\ntitle: T\n---\nBody ![[shot.png]] here.",
      readBinaryMap: { "shot.png": imgBytes },
      resolveMap: { "shot.png": imgFile },
    });

    const result = await exportNote({
      file: NOTE,
      app: app as never,
      client,
      existingPageId: "",
      title: "T",
      spaceKey: "DOC",
      parentId: "0",
    });

    expect(result.pageId).toBe("111");
    // create called first (to get the page id for attachment upload)
    expect(client.createPage).toHaveBeenCalledTimes(1);
    // attachment uploaded
    expect(client.uploadAttachment).toHaveBeenCalledWith(
      "111",
      "shot.png",
      expect.any(Uint8Array),
      expect.stringContaining("image/"),
    );
    // update called with rewritten HTML containing ac:image macro
    expect(client.updatePage).toHaveBeenCalledTimes(1);
    const updateArgs = (client.updatePage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updateArgs.html).toContain('ri:filename="shot.png"');
    expect(updateArgs.html).not.toContain("<img");
  });

  it("skips upload for images already attached to the page", async () => {
    const imgFile = makeImageFile("existing.png");
    const client = makeClient({
      createPage: vi.fn().mockResolvedValue("111"),
      listAttachments: vi.fn().mockResolvedValue([{ id: "a1", title: "existing.png" }]),
    });
    const app = makeApp({
      readContent: "![[existing.png]]",
      readBinaryMap: { "existing.png": new Uint8Array(1200).fill(1) },
      resolveMap: { "existing.png": imgFile },
    });

    await exportNote({
      file: NOTE,
      app: app as never,
      client,
      existingPageId: "",
      title: "T",
      spaceKey: "DOC",
      parentId: "",
    });

    expect(client.uploadAttachment).not.toHaveBeenCalled();
  });

  it("uploads and embeds images whose filename contains spaces", async () => {
    const imgFile = makeImageFile("Pasted image 20260413.png");
    const imgBytes = new Uint8Array(1200).fill(0xab);
    const client = makeClient({ createPage: vi.fn().mockResolvedValue("111") });
    const app = makeApp({
      readContent: "Body ![[Pasted image 20260413.png]] here.",
      readBinaryMap: { "Pasted image 20260413.png": imgBytes },
      resolveMap: { "Pasted image 20260413.png": imgFile },
    });

    const result = await exportNote({
      file: NOTE,
      app: app as never,
      client,
      existingPageId: "",
      title: "T",
      spaceKey: "DOC",
      parentId: "0",
    });

    expect(result.warnings).toEqual([]);
    expect(client.uploadAttachment).toHaveBeenCalledWith(
      "111",
      "Pasted image 20260413.png",
      expect.any(Uint8Array),
      expect.stringContaining("image/"),
    );
    const updateHtml = (client.updatePage as ReturnType<typeof vi.fn>).mock.calls[0][0].html;
    expect(updateHtml).toContain('ri:filename="Pasted image 20260413.png"');
    expect(updateHtml).not.toContain("<img");
  });

  it("returns warnings for unresolved image refs", async () => {
    const client = makeClient();
    const app = makeApp({
      readContent: "![[missing.png]] text",
      resolveMap: { "missing.png": null },
    });

    const result = await exportNote({
      file: NOTE,
      app: app as never,
      client,
      existingPageId: "",
      title: "T",
      spaceKey: "DOC",
      parentId: "",
    });

    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.join(" ")).toMatch(/missing\.png/);
  });
});

describe("exportNote — update path (existing page id)", () => {
  it("does not call createPage; updates existing page", async () => {
    const client = makeClient();
    const app = makeApp({ readContent: "Body text." });

    const result = await exportNote({
      file: NOTE,
      app: app as never,
      client,
      existingPageId: "222",
      title: "T",
      spaceKey: "DOC",
      parentId: "",
    });

    expect(client.createPage).not.toHaveBeenCalled();
    expect(client.updatePage).toHaveBeenCalledTimes(1);
    expect(result.pageId).toBe("222");
  });

  it("falls back to createPage when updatePage throws PageMissingError", async () => {
    // First call (trying to update "222") rejects; second call (final PUT on "333") succeeds.
    const updatePage = vi.fn()
      .mockRejectedValueOnce(new PageMissingError("222"))
      .mockResolvedValue("333");
    const client = makeClient({
      updatePage,
      createPage: vi.fn().mockResolvedValue("333"),
    });
    const app = makeApp({ readContent: "Body." });

    const result = await exportNote({
      file: NOTE,
      app: app as never,
      client,
      existingPageId: "222",
      title: "T",
      spaceKey: "DOC",
      parentId: "",
    });

    expect(client.createPage).toHaveBeenCalledTimes(1);
    expect(result.pageId).toBe("333");
  });
});

describe("exportNote — title change detection", () => {
  it("creates a new page when export title differs from the Confluence page title", async () => {
    const client = makeClient({
      getPageTitle: vi.fn().mockResolvedValue("Old Title"),
      createPage: vi.fn().mockResolvedValue("333"),
    });
    const app = makeApp({ readContent: "Body." });

    const result = await exportNote({
      file: NOTE,
      app: app as never,
      client,
      existingPageId: "222",
      title: "New Title",
      spaceKey: "DOC",
      parentId: "",
    });

    // The old page must never be updated
    const updateCalls = (client.updatePage as ReturnType<typeof vi.fn>).mock.calls;
    expect(updateCalls.every((c) => (c[0] as { pageId: string }).pageId !== "222")).toBe(true);
    // A fresh page is created instead
    expect(client.createPage).toHaveBeenCalledTimes(1);
    expect(result.pageId).toBe("333");
  });

  it("updates in place when export title matches the Confluence page title", async () => {
    const client = makeClient({
      getPageTitle: vi.fn().mockResolvedValue("Same Title"),
    });
    const app = makeApp({ readContent: "Body." });

    const result = await exportNote({
      file: NOTE,
      app: app as never,
      client,
      existingPageId: "222",
      title: "Same Title",
      spaceKey: "DOC",
      parentId: "",
    });

    expect(client.createPage).not.toHaveBeenCalled();
    expect(client.updatePage).toHaveBeenCalledWith(expect.objectContaining({ pageId: "222" }));
    expect(result.pageId).toBe("222");
  });
});

describe("exportNote — image width", () => {
  it("embeds images with ac:width when imageWidth is specified", async () => {
    const imgFile = makeImageFile("shot.png");
    const client = makeClient({ createPage: vi.fn().mockResolvedValue("111") });
    const app = makeApp({
      readContent: "![[shot.png]]",
      readBinaryMap: { "shot.png": new Uint8Array(100) },
      resolveMap: { "shot.png": imgFile },
    });

    await exportNote({
      file: NOTE,
      app: app as never,
      client,
      existingPageId: "",
      title: "T",
      spaceKey: "DOC",
      parentId: "0",
      imageWidth: 800,
    });

    const updateHtml = (client.updatePage as ReturnType<typeof vi.fn>).mock.calls[0][0].html;
    expect(updateHtml).toContain('ac:width="800"');
  });

  it("omits ac:width when imageWidth is not specified", async () => {
    const imgFile = makeImageFile("shot.png");
    const client = makeClient({ createPage: vi.fn().mockResolvedValue("111") });
    const app = makeApp({
      readContent: "![[shot.png]]",
      readBinaryMap: { "shot.png": new Uint8Array(100) },
      resolveMap: { "shot.png": imgFile },
    });

    await exportNote({
      file: NOTE,
      app: app as never,
      client,
      existingPageId: "",
      title: "T",
      spaceKey: "DOC",
      parentId: "0",
    });

    const updateHtml = (client.updatePage as ReturnType<typeof vi.fn>).mock.calls[0][0].html;
    expect(updateHtml).not.toContain("ac:width");
  });
});

describe("exportNote — overwrite existing page by title", () => {
  it("finds the existing page and updates it when overwriteExisting is true", async () => {
    const client = makeClient({
      createPage: vi.fn().mockRejectedValue(new PageExistsError("T")),
      getPageByTitle: vi.fn().mockResolvedValue("999"),
    });
    const app = makeApp({ readContent: "Body." });

    const result = await exportNote({
      file: NOTE,
      app: app as never,
      client,
      existingPageId: "",
      title: "T",
      spaceKey: "DOC",
      parentId: "",
      overwriteExisting: true,
    });

    expect(client.getPageByTitle).toHaveBeenCalledWith("DOC", "T");
    expect(client.updatePage).toHaveBeenCalledWith(expect.objectContaining({ pageId: "999" }));
    expect(result.pageId).toBe("999");
  });

  it("re-throws PageExistsError when overwriteExisting is false (default)", async () => {
    const client = makeClient({
      createPage: vi.fn().mockRejectedValue(new PageExistsError("T")),
    });
    const app = makeApp({ readContent: "Body." });

    await expect(
      exportNote({
        file: NOTE,
        app: app as never,
        client,
        existingPageId: "",
        title: "T",
        spaceKey: "DOC",
        parentId: "",
      }),
    ).rejects.toBeInstanceOf(PageExistsError);
  });

  it("re-throws PageExistsError when overwriteExisting is true but no matching page found", async () => {
    const client = makeClient({
      createPage: vi.fn().mockRejectedValue(new PageExistsError("T")),
      getPageByTitle: vi.fn().mockResolvedValue(null),
    });
    const app = makeApp({ readContent: "Body." });

    await expect(
      exportNote({
        file: NOTE,
        app: app as never,
        client,
        existingPageId: "",
        title: "T",
        spaceKey: "DOC",
        parentId: "",
        overwriteExisting: true,
      }),
    ).rejects.toBeInstanceOf(PageExistsError);
  });
});

describe("exportNote — base64 images", () => {
  it("uploads base64 pasted images as attachments and rewrites to ri:attachment", async () => {
    const bigBytes = new Uint8Array(1200).fill(0xff);
    const b64 = Buffer.from(bigBytes).toString("base64");
    const html = `<img src="data:image/png;base64,${b64}" alt="">`;
    // Use a markdown that produces the base64 img tag directly (inject pre-built HTML via storage)
    // Since marked won't produce base64, we inject it as raw HTML in the markdown.
    const client = makeClient({ createPage: vi.fn().mockResolvedValue("555") });
    const app = makeApp({ readContent: html });

    const result = await exportNote({
      file: NOTE,
      app: app as never,
      client,
      existingPageId: "",
      title: "T",
      spaceKey: "DOC",
      parentId: "",
    });

    expect(client.uploadAttachment).toHaveBeenCalledTimes(1);
    const [, filename] = (client.uploadAttachment as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(filename).toMatch(/^[0-9a-f]{12}\.png$/);
    const updateHtml = (client.updatePage as ReturnType<typeof vi.fn>).mock.calls[0][0].html;
    expect(updateHtml).not.toContain("data:image");
    expect(updateHtml).toContain("ri:attachment");
    expect(result.pageId).toBe("555");
  });
});
