import { marked } from "marked";

export function markdownToStorage(md: string): string {
  return marked.parse(md, { async: false, gfm: true, breaks: false }) as string;
}

export function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return content;
  const afterNewline = content.indexOf("\n", end + 4);
  return afterNewline === -1 ? "" : content.slice(afterNewline + 1);
}
