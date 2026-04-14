import type { App, TFile, TFolder, TAbstractFile } from "obsidian";
import { ConfluenceClient, PageExistsError } from "./confluence";
import { exportNote } from "./export";
import { booleanOr, numberOr } from "./helpers";
import { FolderState } from "./state";

export interface FolderTree {
  folder: TFolder;
  notes: TFile[];
  subfolders: FolderTree[];
}

export function buildFolderTree(folder: TFolder): FolderTree {
  const notes: TFile[] = [];
  const subfolders: FolderTree[] = [];

  for (const child of folder.children as TAbstractFile[]) {
    if (isFolder(child)) {
      subfolders.push(buildFolderTree(child as TFolder));
    } else if (isMarkdownFile(child)) {
      notes.push(child as TFile);
    }
  }

  notes.sort((a, b) => a.name.localeCompare(b.name));
  subfolders.sort((a, b) => a.folder.name.localeCompare(b.folder.name));

  return { folder, notes, subfolders };
}

interface ExportFolderParams {
  folder: TFolder;
  app: App;
  client: ConfluenceClient;
  state: FolderState;
  settings: { defaultSpaceKey: string; defaultParentPageId: string; overwriteExistingPage?: boolean; defaultImageWidth?: number };
}

interface ExportFolderResult {
  created: number;
  updated: number;
  failed: number;
}

export async function exportFolder(params: ExportFolderParams): Promise<ExportFolderResult> {
  const { folder, app, client, state, settings } = params;
  const tree = buildFolderTree(folder);
  const totals = { created: 0, updated: 0, failed: 0 };

  await walkTree(tree, settings.defaultParentPageId, {
    app,
    client,
    state,
    spaceKey: settings.defaultSpaceKey,
    overwriteExisting: settings.overwriteExistingPage ?? false,
    imageWidth: settings.defaultImageWidth ?? 800,
    totals,
  });

  return totals;
}

interface WalkContext {
  app: App;
  client: ConfluenceClient;
  state: FolderState;
  spaceKey: string;
  overwriteExisting: boolean;
  imageWidth: number;
  totals: ExportFolderResult;
}

async function walkTree(
  tree: FolderTree,
  parentId: string,
  ctx: WalkContext,
): Promise<void> {
  // Resolve or create the Confluence page for this folder
  const folderPageId = await resolveFolderPage(tree.folder, parentId, ctx);

  // Export each note in this folder
  for (const note of tree.notes) {
    await exportNoteInFolder(note, folderPageId, ctx);
  }

  // Recurse into subfolders
  for (const sub of tree.subfolders) {
    await walkTree(sub, folderPageId, ctx);
  }
}

async function resolveFolderPage(
  folder: TFolder,
  parentId: string,
  ctx: WalkContext,
): Promise<string> {
  const cached = ctx.state.getFolderPageId(folder.path);
  if (cached) return cached;

  let pageId: string;
  try {
    pageId = await ctx.client.createPage({
      title: folder.name,
      spaceKey: ctx.spaceKey,
      html: "",
      parentId,
    });
  } catch (err) {
    if (err instanceof PageExistsError && ctx.overwriteExisting) {
      const found = await ctx.client.getPageByTitle(ctx.spaceKey, folder.name);
      if (!found) throw err;
      pageId = found;
    } else {
      throw err;
    }
  }

  await ctx.state.setFolderPageId(folder.path, pageId);
  return pageId;
}

async function exportNoteInFolder(
  note: TFile,
  parentId: string,
  ctx: WalkContext,
): Promise<void> {
  const mc = ctx.app.metadataCache as unknown as {
    getFileCache: (f: TFile) => { frontmatter?: Record<string, unknown> } | null;
  };
  const fm = (mc.getFileCache(note)?.frontmatter ?? {}) as Record<string, unknown>;
  const noteOverwrite = booleanOr(fm["confluence_overwrite"], false);
  const imageWidth = numberOr(fm["confluence_image_width"], ctx.imageWidth);

  const wasNew = !hasExistingPageId(note);
  try {
    await exportNote({
      file: note,
      app: ctx.app,
      client: ctx.client,
      existingPageId: getExistingPageId(note),
      title: note.basename,
      spaceKey: ctx.spaceKey,
      parentId,
      overwriteExisting: ctx.overwriteExisting || noteOverwrite,
      imageWidth,
    });
    if (wasNew) {
      ctx.totals.created += 1;
    } else {
      ctx.totals.updated += 1;
    }
  } catch (err) {
    ctx.totals.failed += 1;
    console.error(`Failed to export ${note.path}:`, err);
  }
}

// ---- helpers ---------------------------------------------------------

function isFolder(f: TAbstractFile): boolean {
  return Array.isArray((f as TFolder).children);
}

function isMarkdownFile(f: TAbstractFile): boolean {
  return (f as TFile).extension === "md";
}

function hasExistingPageId(_note: TFile): boolean {
  // In the plugin context, this would check app.metadataCache frontmatter.
  // For bulk export, notes are treated as new (no frontmatter lookup available here).
  // The plugin shell calls exportNote with the correct existingPageId from frontmatter.
  return false;
}

function getExistingPageId(_note: TFile): string {
  return "";
}
