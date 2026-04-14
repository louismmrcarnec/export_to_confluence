import { describe, it, expect, vi } from "vitest";
import { TFile, TFolder } from "obsidian";
import { buildFolderTree, exportFolder } from "./bulk";
import { ConfluenceClient, PageMissingError, PageExistsError } from "./confluence";
import { FolderState } from "./state";

// ---- helpers ---------------------------------------------------------

function makeFolder(name: string, path: string, parent: TFolder | null = null): TFolder {
  const f = new TFolder();
  f.name = name;
  f.path = path;
  f.parent = parent;
  f.children = [];
  return f;
}

function makeNote(name: string, folderPath: string, folder: TFolder): TFile {
  const f = new TFile();
  f.name = name;
  f.basename = name.replace(".md", "");
  f.extension = "md";
  f.path = `${folderPath}/${name}`;
  f.parent = folder;
  return f;
}

function makeClient(overrides: Record<string, unknown> = {}): ConfluenceClient {
  return {
    createPage: vi.fn().mockResolvedValue("new-id"),
    updatePage: vi.fn().mockResolvedValue("upd-id"),
    listAttachments: vi.fn().mockResolvedValue([]),
    uploadAttachment: vi.fn().mockResolvedValue(undefined),
    getPageTitle: vi.fn().mockResolvedValue(""),
    getPageByTitle: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as ConfluenceClient;
}

function makeApp(readContent = "Body.") {
  return {
    vault: {
      read: vi.fn().mockResolvedValue(readContent),
      readBinary: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
    },
    metadataCache: {
      getFirstLinkpathDest: vi.fn().mockReturnValue(null),
      getFileCache: vi.fn().mockReturnValue(null),
    },
  };
}

function makeAppWithFm(readContent: string, fm: Record<string, unknown>) {
  return {
    vault: {
      read: vi.fn().mockResolvedValue(readContent),
      readBinary: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
    },
    metadataCache: {
      getFirstLinkpathDest: vi.fn().mockReturnValue(null),
      getFileCache: vi.fn().mockReturnValue({ frontmatter: fm }),
    },
  };
}

// ---- buildFolderTree -------------------------------------------------

describe("buildFolderTree", () => {
  it("returns a tree with the folder and its direct notes", () => {
    const root = makeFolder("Docs", "Docs");
    const note = makeNote("intro.md", "Docs", root);
    root.children = [note];

    const tree = buildFolderTree(root);
    expect(tree.folder).toBe(root);
    expect(tree.notes).toHaveLength(1);
    expect(tree.notes[0]).toBe(note);
    expect(tree.subfolders).toHaveLength(0);
  });

  it("recurses into subfolders", () => {
    const root = makeFolder("Docs", "Docs");
    const sub = makeFolder("Sub", "Docs/Sub", root);
    const subNote = makeNote("page.md", "Docs/Sub", sub);
    sub.children = [subNote];
    root.children = [sub];

    const tree = buildFolderTree(root);
    expect(tree.subfolders).toHaveLength(1);
    expect(tree.subfolders[0].folder).toBe(sub);
    expect(tree.subfolders[0].notes[0]).toBe(subNote);
  });

  it("ignores non-md files in the notes list", () => {
    const root = makeFolder("Docs", "Docs");
    const img = new TFile();
    img.extension = "png";
    img.name = "shot.png";
    img.path = "Docs/shot.png";
    const note = makeNote("a.md", "Docs", root);
    root.children = [img, note];

    const tree = buildFolderTree(root);
    expect(tree.notes).toHaveLength(1);
    expect(tree.notes[0]).toBe(note);
  });

  it("sorts notes and subfolders by name", () => {
    const root = makeFolder("R", "R");
    const subB = makeFolder("B", "R/B", root);
    const subA = makeFolder("A", "R/A", root);
    const noteZ = makeNote("z.md", "R", root);
    const noteA = makeNote("a.md", "R", root);
    subA.children = [];
    subB.children = [];
    root.children = [noteZ, subB, noteA, subA];

    const tree = buildFolderTree(root);
    expect(tree.notes.map((n) => n.name)).toEqual(["a.md", "z.md"]);
    expect(tree.subfolders.map((s) => s.folder.name)).toEqual(["A", "B"]);
  });
});

// ---- exportFolder ----------------------------------------------------

describe("exportFolder", () => {
  it("creates a page for the root folder then exports notes under it", async () => {
    const root = makeFolder("Docs", "Docs");
    const note = makeNote("intro.md", "Docs", root);
    root.children = [note];

    const client = makeClient({ createPage: vi.fn().mockResolvedValue("folder-page-1") });
    const saveStub = vi.fn().mockResolvedValue(undefined);
    const state = new FolderState({}, saveStub);
    const app = makeApp("# Intro\n");

    const result = await exportFolder({
      folder: root,
      app: app as never,
      client,
      state,
      settings: { defaultSpaceKey: "DOC", defaultParentPageId: "root-0" },
    });

    // Root folder page created under the default parent
    expect(client.createPage).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Docs", parentId: "root-0" }),
    );
    expect(result.created).toBeGreaterThan(0);
    expect(result.failed).toBe(0);
  });

  it("reuses an existing folder page id from state", async () => {
    const root = makeFolder("Docs", "Docs");
    const note = makeNote("intro.md", "Docs", root);
    root.children = [note];

    const client = makeClient();
    const state = new FolderState({ Docs: "existing-folder-99" }, vi.fn().mockResolvedValue(undefined));
    const app = makeApp("Body.");

    await exportFolder({
      folder: root,
      app: app as never,
      client,
      state,
      settings: { defaultSpaceKey: "DOC", defaultParentPageId: "0" },
    });

    // Should NOT create a page for "Docs" because state already has an id
    const createCalls = (client.createPage as ReturnType<typeof vi.fn>).mock.calls;
    const folderCreate = createCalls.filter((c) => c[0].title === "Docs");
    expect(folderCreate).toHaveLength(0);
  });

  it("aggregates created/updated/failed counts", async () => {
    const root = makeFolder("R", "R");
    const note1 = makeNote("a.md", "R", root);
    const note2 = makeNote("b.md", "R", root);
    root.children = [note1, note2];

    const client = makeClient({
      createPage: vi.fn()
        .mockResolvedValueOnce("folder-id")  // folder page
        .mockResolvedValueOnce("n1")          // note a
        .mockResolvedValueOnce("n2"),         // note b
    });
    const state = new FolderState({}, vi.fn().mockResolvedValue(undefined));
    const app = makeApp("Body.");

    const result = await exportFolder({
      folder: root,
      app: app as never,
      client,
      state,
      settings: { defaultSpaceKey: "S", defaultParentPageId: "" },
    });

    expect(result.created + result.updated).toBe(2); // 2 notes
    expect(result.failed).toBe(0);
  });

  it("counts a failed note export in the failed tally", async () => {
    const root = makeFolder("R", "R");
    const note = makeNote("bad.md", "R", root);
    root.children = [note];

    const client = makeClient({
      createPage: vi.fn()
        .mockResolvedValueOnce("folder-id") // folder page
        .mockRejectedValueOnce(new Error("Confluence error")), // note export fails
    });
    const state = new FolderState({}, vi.fn().mockResolvedValue(undefined));
    const app = makeApp("Body.");

    const result = await exportFolder({
      folder: root,
      app: app as never,
      client,
      state,
      settings: { defaultSpaceKey: "S", defaultParentPageId: "" },
    });

    expect(result.failed).toBe(1);
  });

  it("exports notes in nested subfolders under the correct parent", async () => {
    const root = makeFolder("Docs", "Docs");
    const sub = makeFolder("2026", "Docs/2026", root);
    const note = makeNote("q1.md", "Docs/2026", sub);
    sub.children = [note];
    root.children = [sub];

    let callCount = 0;
    const client = makeClient({
      createPage: vi.fn().mockImplementation(async (p: { title: string; parentId: string }) => {
        callCount++;
        if (p.title === "Docs") return "docs-id";
        if (p.title === "2026") return "2026-id";
        return `note-${callCount}`;
      }),
    });
    const state = new FolderState({}, vi.fn().mockResolvedValue(undefined));
    const app = makeApp("Q1 content.");

    await exportFolder({
      folder: root,
      app: app as never,
      client,
      state,
      settings: { defaultSpaceKey: "DOC", defaultParentPageId: "root-0" },
    });

    // The note q1.md should have been exported with parentId = "2026-id"
    const createCalls = (client.createPage as ReturnType<typeof vi.fn>).mock.calls;
    const noteCall = createCalls.find((c) => c[0].title === "q1");
    expect(noteCall).toBeDefined();
    expect(noteCall[0].parentId).toBe("2026-id");
  });

  it("applies defaultImageWidth from settings to embedded images", async () => {
    const root = makeFolder("R", "R");
    const note = makeNote("pg.md", "R", root);
    root.children = [note];

    const bigBytes = new Uint8Array(1200).fill(0xff);
    const b64 = Buffer.from(bigBytes).toString("base64");

    const client = makeClient({
      createPage: vi.fn()
        .mockResolvedValueOnce("folder-id")
        .mockResolvedValueOnce("note-id"),
    });
    const app = makeAppWithFm(`<img src="data:image/png;base64,${b64}" alt="">`, {});
    const state = new FolderState({}, vi.fn().mockResolvedValue(undefined));

    await exportFolder({
      folder: root,
      app: app as never,
      client,
      state,
      settings: { defaultSpaceKey: "S", defaultParentPageId: "", defaultImageWidth: 800 },
    });

    const updateHtml = (client.updatePage as ReturnType<typeof vi.fn>).mock.calls[0][0].html;
    expect(updateHtml).toContain('ac:width="800"');
  });

  it("overrides defaultImageWidth with confluence_image_width in note frontmatter", async () => {
    const root = makeFolder("R", "R");
    const note = makeNote("pg.md", "R", root);
    root.children = [note];

    const bigBytes = new Uint8Array(1200).fill(0xff);
    const b64 = Buffer.from(bigBytes).toString("base64");

    const client = makeClient({
      createPage: vi.fn()
        .mockResolvedValueOnce("folder-id")
        .mockResolvedValueOnce("note-id"),
    });
    const app = makeAppWithFm(`<img src="data:image/png;base64,${b64}" alt="">`, { confluence_image_width: 400 });
    const state = new FolderState({}, vi.fn().mockResolvedValue(undefined));

    await exportFolder({
      folder: root,
      app: app as never,
      client,
      state,
      settings: { defaultSpaceKey: "S", defaultParentPageId: "", defaultImageWidth: 800 },
    });

    const updateHtml = (client.updatePage as ReturnType<typeof vi.fn>).mock.calls[0][0].html;
    expect(updateHtml).toContain('ac:width="400"');
    expect(updateHtml).not.toContain('ac:width="800"');
  });

  it("overwrites an existing page when note frontmatter has confluence_overwrite: true, even with global setting off", async () => {
    const root = makeFolder("R", "R");
    const note = makeNote("pg.md", "R", root);
    root.children = [note];

    const client = makeClient({
      createPage: vi.fn()
        .mockResolvedValueOnce("folder-id")
        .mockRejectedValueOnce(new PageExistsError("pg")),
      getPageByTitle: vi.fn().mockResolvedValue("existing-99"),
    });

    const app = makeAppWithFm("Body.", { confluence_overwrite: true });
    const state = new FolderState({}, vi.fn().mockResolvedValue(undefined));

    const result = await exportFolder({
      folder: root,
      app: app as never,
      client,
      state,
      settings: { defaultSpaceKey: "S", defaultParentPageId: "", overwriteExistingPage: false },
    });

    expect(client.getPageByTitle).toHaveBeenCalledWith("S", "pg");
    expect(result.failed).toBe(0);
    expect(result.created).toBe(1);
  });
});
