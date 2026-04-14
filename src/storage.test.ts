import { describe, it, expect } from "vitest";
import { markdownToStorage, stripFrontmatter } from "./storage";

describe("markdownToStorage", () => {
  it("converts headings", () => {
    expect(markdownToStorage("# hello")).toContain("<h1>hello</h1>");
  });

  it("converts paragraphs", () => {
    expect(markdownToStorage("hello world")).toContain("<p>hello world</p>");
  });

  it("converts fenced code blocks", () => {
    const html = markdownToStorage("```\nlet x = 1;\n```");
    expect(html).toMatch(/<pre><code>[\s\S]*let x = 1;[\s\S]*<\/code><\/pre>/);
  });

  it("converts GFM tables", () => {
    const md = "| a | b |\n| - | - |\n| 1 | 2 |";
    const html = markdownToStorage(md);
    expect(html).toContain("<table>");
    expect(html).toContain("<th>a</th>");
    expect(html).toContain("<td>1</td>");
  });

  it("preserves raw img tags", () => {
    expect(markdownToStorage("![alt](foo.png)")).toContain('src="foo.png"');
  });
});

describe("stripFrontmatter", () => {
  it("removes YAML frontmatter block", () => {
    const input = "---\ntitle: x\n---\nbody text";
    expect(stripFrontmatter(input)).toBe("body text");
  });

  it("returns unchanged content when no frontmatter", () => {
    expect(stripFrontmatter("# heading")).toBe("# heading");
  });

  it("handles frontmatter with no trailing body", () => {
    expect(stripFrontmatter("---\nk: v\n---")).toBe("");
  });
});
