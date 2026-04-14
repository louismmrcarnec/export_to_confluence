import type { App, TFile } from "obsidian";
import { ConfluenceClient, PageMissingError, PageExistsError } from "./confluence";
import {
  collectMarkdownImageRefs,
  collectBase64ImageRefs,
  resolveImageRefs,
  rewriteMarkdownEmbedsToPlainImg,
  rewriteHtmlToAttachmentMacros,
} from "./images";
import { markdownToStorage, stripFrontmatter } from "./storage";

interface ExportNoteParams {
  file: TFile;
  app: App;
  client: ConfluenceClient;
  existingPageId: string;
  title: string;
  spaceKey: string;
  parentId: string;
  imageWidth?: number;
  overwriteExisting?: boolean;
}

interface ExportNoteResult {
  pageId: string;
  warnings: string[];
}

export async function exportNote(params: ExportNoteParams): Promise<ExportNoteResult> {
  const { file, app, client, title, spaceKey, parentId, imageWidth, overwriteExisting } = params;
  let existingPageId = params.existingPageId;
  const warnings: string[] = [];

  // 0. When updating an existing page, verify the Confluence title still matches.
  //    If the note was renamed, create a new page instead of renaming the old one.
  if (existingPageId) {
    try {
      const confluenceTitle = await client.getPageTitle(existingPageId);
      if (confluenceTitle !== title) {
        existingPageId = "";
      }
    } catch (err) {
      if (err instanceof PageMissingError) {
        existingPageId = "";
      } else {
        throw err;
      }
    }
  }

  // 1. Read + strip frontmatter
  const vault = app.vault as { read: (f: TFile) => Promise<string>; readBinary: (f: TFile) => Promise<ArrayBuffer> };
  const raw = await vault.read(file);
  const body = stripFrontmatter(raw);

  // 2. Collect + resolve vault image refs
  const markdownRefs = collectMarkdownImageRefs(body);
  const resolved = resolveImageRefs(markdownRefs, app, file.path);

  // Warn about unresolved markdown image refs
  for (const ref of markdownRefs) {
    if (!resolved.some((r) => r.ref.raw === ref.raw)) {
      warnings.push(`Could not resolve image: ${ref.linkpath}`);
    }
  }

  // 3. Rewrite markdown embeds to plain img tags, then convert to HTML
  const rewriteRefs = resolved.map((r) => ({
    raw: r.ref.raw,
    alt: r.ref.alt,
    targetFilename: r.targetFilename,
  }));
  const rewrittenMd = rewriteMarkdownEmbedsToPlainImg(body, rewriteRefs);
  const html = markdownToStorage(rewrittenMd);

  // 4. Collect base64 image refs from the generated HTML
  const base64Refs = collectBase64ImageRefs(html);

  // 5. Create or locate page to get a pageId for attachment upload
  if (!existingPageId) {
    try {
      existingPageId = await client.createPage({ title, spaceKey, html, parentId });
    } catch (err) {
      if (err instanceof PageExistsError && overwriteExisting) {
        const found = await client.getPageByTitle(spaceKey, title);
        if (!found) throw err;
        existingPageId = found;
      } else {
        throw err;
      }
    }
  }

  // 6. Upload new attachments (skip ones already attached)
  const existing = await client.listAttachments(existingPageId);
  const existingTitles = new Set(existing.map((a) => a.title));

  for (const r of resolved) {
    if (existingTitles.has(r.targetFilename)) continue;
    const buf = await vault.readBinary(r.vaultFile);
    const bytes = new Uint8Array(buf);
    const mimeType = guessMime(r.targetFilename);
    await client.uploadAttachment(existingPageId, r.targetFilename, bytes, mimeType);
  }

  for (const ref of base64Refs) {
    if (existingTitles.has(ref.filename)) continue;
    await client.uploadAttachment(existingPageId, ref.filename, ref.bytes, guessMime(ref.filename));
  }

  // 7. Build filename map and rewrite HTML to Confluence storage macros
  const filenameMap: Record<string, string> = {};
  for (const r of resolved) {
    filenameMap[encodeURIComponent(r.targetFilename)] = r.targetFilename;
  }
  for (const ref of base64Refs) {
    filenameMap[ref.originalSrc] = ref.filename;
  }

  const { html: finalHtml, unresolved } = rewriteHtmlToAttachmentMacros(html, filenameMap, imageWidth);
  for (const src of unresolved) {
    warnings.push(`Image left as-is (not uploaded): ${src}`);
  }

  // 8. PUT final content (handles both create-path final update and update-path)
  try {
    await client.updatePage({
      pageId: existingPageId,
      title,
      spaceKey,
      html: finalHtml,
      parentId,
    });
  } catch (err) {
    if (err instanceof PageMissingError) {
      // Page vanished between create and final PUT — create fresh and use that id
      existingPageId = await client.createPage({ title, spaceKey, html: finalHtml, parentId });
    } else {
      throw err;
    }
  }

  return { pageId: existingPageId, warnings };
}

function guessMime(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    webp: "image/webp",
    bmp: "image/bmp",
    avif: "image/avif",
  };
  return map[ext] ?? "application/octet-stream";
}
