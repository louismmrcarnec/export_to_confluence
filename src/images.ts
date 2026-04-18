import type { TFile, App } from "obsidian";

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|svg|webp|bmp|avif)$/i;

const MIME_TO_EXT: Record<string, string> = {
  png: "png",
  jpeg: "jpg",
  jpg: "jpg",
  gif: "gif",
  "svg+xml": "svg",
  webp: "webp",
  bmp: "bmp",
  avif: "avif",
};

export interface Base64ImageRef {
  originalSrc: string;
  bytes: Uint8Array;
  filename: string;
}

export interface MarkdownImageRef {
  kind: "wikilink" | "markdown";
  linkpath: string;
  alt: string;
  raw: string;
  index: number;
}

export function collectMarkdownImageRefs(md: string): MarkdownImageRef[] {
  const masked = maskCode(md);
  const refs: MarkdownImageRef[] = [];

  const wikilinkRe = /!\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g;
  for (const m of masked.matchAll(wikilinkRe)) {
    const linkpathRaw = m[1].trim();
    if (!IMAGE_EXT_RE.test(linkpathRaw)) continue;
    refs.push({
      kind: "wikilink",
      linkpath: linkpathRaw,
      alt: (m[2] ?? "").trim(),
      raw: m[0],
      index: m.index ?? 0,
    });
  }

  const mdRe = /!\[([^\]]*)\]\(([^)]+)\)/g;
  for (const m of masked.matchAll(mdRe)) {
    const rawPath = m[2].trim();
    let linkpath = rawPath;
    try {
      linkpath = decodeURIComponent(rawPath);
    } catch {
      // fall back to the raw string if decoding fails
    }
    refs.push({
      kind: "markdown",
      linkpath,
      alt: m[1],
      raw: m[0],
      index: m.index ?? 0,
    });
  }

  refs.sort((a, b) => a.index - b.index);
  return refs;
}

export function collectBase64ImageRefs(html: string): Base64ImageRef[] {
  const refs: Base64ImageRef[] = [];
  const seen = new Set<string>();
  const re = /<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
  for (const m of html.matchAll(re)) {
    const src = m[1] ?? m[2] ?? "";
    const b64 = /^data:image\/([a-zA-Z0-9+]+);base64,(.+)$/i.exec(src);
    if (!b64) continue;

    const subtype = b64[1].toLowerCase();
    const payload = b64[2];

    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(payload);
    } catch {
      continue;
    }

    if (bytes.byteLength < 1024) continue;

    const hash = hashBytes(bytes);
    if (seen.has(hash)) continue;
    seen.add(hash);

    const ext = MIME_TO_EXT[subtype] ?? "png";
    refs.push({
      originalSrc: src,
      bytes,
      filename: `${hash}.${ext}`,
    });
  }
  return refs;
}

export interface RewriteMarkdownRef {
  raw: string;
  alt: string;
  targetFilename: string;
}

export function rewriteMarkdownEmbedsToPlainImg(
  md: string,
  refs: RewriteMarkdownRef[],
): string {
  let out = md;
  for (const ref of refs) {
    const replacement = `![${ref.alt}](${encodeURIComponent(ref.targetFilename)})`;
    out = out.split(ref.raw).join(replacement);
  }
  return out;
}

export interface ResolvedImageRef {
  ref: MarkdownImageRef;
  vaultFile: TFile;
  targetFilename: string;
}

/**
 * Resolve vault-relative linkpaths to actual TFile handles using Obsidian's
 * metadata cache. Refs that cannot be resolved are silently dropped (the
 * caller should surface any warnings via Notice).
 */
export function resolveImageRefs(
  refs: MarkdownImageRef[],
  app: App,
  sourcePath: string,
): ResolvedImageRef[] {
  const mc = app.metadataCache as {
    getFirstLinkpathDest: (linkpath: string, sourcePath: string) => TFile | null;
  };
  const resolved: ResolvedImageRef[] = [];
  for (const ref of refs) {
    const file = mc.getFirstLinkpathDest(ref.linkpath, sourcePath);
    if (!file) continue;
    resolved.push({ ref, vaultFile: file, targetFilename: file.name });
  }
  return resolved;
}

export interface RewriteHtmlResult {
  html: string;
  unresolved: string[];
}

export function rewriteHtmlToAttachmentMacros(
  html: string,
  filenameMap: Record<string, string>,
  width?: number,
): RewriteHtmlResult {
  const unresolved: string[] = [];
  // Match opening <img ...> tag (self-closing or not). Capture the attribute
  // section so we can pull src/alt without committing to attribute order.
  const imgRe = /<img\b([^>]*?)\/?>/gi;
  const out = html.replace(imgRe, (match, attrs: string) => {
    const src = extractAttr(attrs, "src");
    if (!src) return match;
    const targetFilename = filenameMap[src];
    if (!targetFilename) {
      unresolved.push(src);
      return match;
    }
    const alt = extractAttr(attrs, "alt") ?? "";
    const widthPart = width !== undefined ? ` ac:width="${width}"` : "";
    const altPart = alt ? ` ac:alt="${escapeXml(alt)}"` : "";
    return `<ac:image${widthPart}${altPart}><ri:attachment ri:filename="${escapeXml(targetFilename)}" /></ac:image>`;
  });
  return { html: out, unresolved };
}

function extractAttr(attrs: string, name: string): string | undefined {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i");
  const m = re.exec(attrs);
  if (!m) return undefined;
  return m[1] ?? m[2] ?? "";
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function hashBytes(bytes: Uint8Array): string {
  // Two-pass FNV-1a 32-bit for a 12-char hex dedup key (no crypto import needed).
  let h1 = 0x811c9dc5;
  let h2 = 0xc4635c28;
  for (const b of bytes) {
    h1 = Math.imul(h1 ^ b, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ b, 0x01000193) >>> 0;
  }
  return (
    h1.toString(16).padStart(8, "0").slice(0, 6) +
    h2.toString(16).padStart(8, "0").slice(0, 6)
  );
}

function decodeBase64(payload: string): Uint8Array {
  // Buffer is available in Electron renderer and in node (vitest environment).
  return new Uint8Array(Buffer.from(payload, "base64"));
}

/**
 * Replace fenced code blocks and inline code with spaces of equal length so
 * regex index positions line up with the original string while image tokens
 * inside code are ignored.
 */
function maskCode(md: string): string {
  let out = "";
  let i = 0;
  while (i < md.length) {
    // Fenced block: ``` ... ``` (also handles ~~~ since Obsidian is rarely that)
    if (md.startsWith("```", i)) {
      const end = md.indexOf("```", i + 3);
      if (end === -1) {
        out += " ".repeat(md.length - i);
        return out;
      }
      out += " ".repeat(end + 3 - i);
      i = end + 3;
      continue;
    }
    // Inline code: `...` on the same line
    if (md[i] === "`") {
      const end = md.indexOf("`", i + 1);
      const newline = md.indexOf("\n", i + 1);
      if (end !== -1 && (newline === -1 || end < newline)) {
        out += " ".repeat(end + 1 - i);
        i = end + 1;
        continue;
      }
    }
    out += md[i];
    i += 1;
  }
  return out;
}
