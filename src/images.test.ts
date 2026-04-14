import { describe, it, expect } from "vitest";
import {
  collectMarkdownImageRefs,
  collectBase64ImageRefs,
  rewriteMarkdownEmbedsToPlainImg,
  rewriteHtmlToAttachmentMacros,
  resolveImageRefs,
} from "./images";
import { TFile } from "obsidian";

describe("collectMarkdownImageRefs", () => {
  it("finds a wikilink image embed", () => {
    const refs = collectMarkdownImageRefs("Here: ![[screenshot.png]] end.");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      kind: "wikilink",
      linkpath: "screenshot.png",
      raw: "![[screenshot.png]]",
    });
  });

  it("parses alt text from a piped wikilink", () => {
    const refs = collectMarkdownImageRefs("![[screenshot.png|My Screenshot]]");
    expect(refs[0]).toMatchObject({
      kind: "wikilink",
      linkpath: "screenshot.png",
      alt: "My Screenshot",
    });
  });

  it("finds a standard markdown image", () => {
    const refs = collectMarkdownImageRefs("![caption](path/to/img.jpg)");
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({
      kind: "markdown",
      linkpath: "path/to/img.jpg",
      alt: "caption",
      raw: "![caption](path/to/img.jpg)",
    });
  });

  it("decodes URL-encoded paths", () => {
    const refs = collectMarkdownImageRefs("![](path/with%20space/img.png)");
    expect(refs[0].linkpath).toBe("path/with space/img.png");
  });

  it("recognises multiple image extensions", () => {
    const md = [
      "![[a.png]]",
      "![[b.jpg]]",
      "![[c.jpeg]]",
      "![[d.gif]]",
      "![[e.svg]]",
      "![[f.webp]]",
    ].join("\n");
    const refs = collectMarkdownImageRefs(md);
    expect(refs.map((r) => r.linkpath)).toEqual([
      "a.png",
      "b.jpg",
      "c.jpeg",
      "d.gif",
      "e.svg",
      "f.webp",
    ]);
  });

  it("ignores wikilink note embeds without image extensions", () => {
    const refs = collectMarkdownImageRefs("See ![[My Other Note]] for context.");
    expect(refs).toEqual([]);
  });

  it("ignores images inside inline code", () => {
    const refs = collectMarkdownImageRefs("Use `![[nope.png]]` syntax.");
    expect(refs).toEqual([]);
  });

  it("ignores images inside fenced code blocks", () => {
    const md = "```\n![[nope.png]]\n![real](nope.png)\n```\n![yes](real.png)";
    const refs = collectMarkdownImageRefs(md);
    expect(refs).toHaveLength(1);
    expect(refs[0].linkpath).toBe("real.png");
  });

  it("treats case-insensitive extensions", () => {
    const refs = collectMarkdownImageRefs("![[Screenshot.PNG]]");
    expect(refs).toHaveLength(1);
    expect(refs[0].linkpath).toBe("Screenshot.PNG");
  });

  it("handles mixed sources in one document", () => {
    const md = "![[a.png]] and ![b](c.jpg)";
    const refs = collectMarkdownImageRefs(md);
    expect(refs.map((r) => [r.kind, r.linkpath])).toEqual([
      ["wikilink", "a.png"],
      ["markdown", "c.jpg"],
    ]);
  });
});

describe("collectBase64ImageRefs", () => {
  // 1200 bytes so we pass the >=1024 filter
  const bigPngBytes = new Uint8Array(1200).fill(0x41);
  const bigPngB64 = base64Encode(bigPngBytes);

  const bigJpgBytes = new Uint8Array(2000).fill(0x42);
  const bigJpgB64 = base64Encode(bigJpgBytes);

  it("extracts png base64 images over the size threshold", () => {
    const html = `<p><img src="data:image/png;base64,${bigPngB64}" /></p>`;
    const refs = collectBase64ImageRefs(html);
    expect(refs).toHaveLength(1);
    expect(refs[0].filename).toMatch(/^[0-9a-f]{12}\.png$/);
    expect(refs[0].bytes.length).toBe(1200);
    expect(refs[0].originalSrc).toBe(
      `data:image/png;base64,${bigPngB64}`,
    );
  });

  it("skips data URIs under 1KB", () => {
    const small = base64Encode(new Uint8Array(100).fill(0x43));
    const html = `<img src="data:image/png;base64,${small}">`;
    expect(collectBase64ImageRefs(html)).toEqual([]);
  });

  it("maps mime subtypes to extensions", () => {
    const cases: [string, string][] = [
      ["jpeg", "jpg"],
      ["gif", "gif"],
      ["svg+xml", "svg"],
      ["webp", "webp"],
    ];
    for (const [mime, ext] of cases) {
      const bytes = new Uint8Array(1200).fill(0x44);
      const b64 = base64Encode(bytes);
      const html = `<img src="data:image/${mime};base64,${b64}">`;
      const refs = collectBase64ImageRefs(html);
      expect(refs).toHaveLength(1);
      expect(refs[0].filename.endsWith(`.${ext}`)).toBe(true);
    }
  });

  it("deduplicates identical byte contents", () => {
    const html = `<img src="data:image/png;base64,${bigPngB64}">\n<img src="data:image/png;base64,${bigPngB64}">`;
    const refs = collectBase64ImageRefs(html);
    expect(refs).toHaveLength(1);
  });

  it("produces stable filenames across calls (content-hashed)", () => {
    const html1 = `<img src="data:image/png;base64,${bigPngB64}">`;
    const html2 = `<img src="data:image/png;base64,${bigPngB64}">`;
    expect(collectBase64ImageRefs(html1)[0].filename).toBe(
      collectBase64ImageRefs(html2)[0].filename,
    );
  });

  it("produces distinct filenames for different bytes", () => {
    const a = `<img src="data:image/png;base64,${bigPngB64}">`;
    const b = `<img src="data:image/jpeg;base64,${bigJpgB64}">`;
    const [refA] = collectBase64ImageRefs(a);
    const [refB] = collectBase64ImageRefs(b);
    expect(refA.filename).not.toBe(refB.filename);
  });
});

describe("resolveImageRefs", () => {
  function makeTFile(name: string): TFile {
    const f = new TFile();
    f.name = name;
    f.path = `attachments/${name}`;
    f.basename = name.replace(/\.[^.]+$/, "");
    f.extension = name.split(".").pop() ?? "";
    return f;
  }

  function makeApp(
    resolveMap: Record<string, TFile | null>,
  ): { metadataCache: { getFirstLinkpathDest: (lp: string, src: string) => TFile | null } } {
    return {
      metadataCache: {
        getFirstLinkpathDest: (lp: string) => resolveMap[lp] ?? null,
      },
    };
  }

  it("resolves a wikilink ref to a TFile and targetFilename", () => {
    const file = makeTFile("shot.png");
    const app = makeApp({ "shot.png": file });
    const refs = collectMarkdownImageRefs("![[shot.png]]");
    const resolved = resolveImageRefs(refs, app as never, "Notes/note.md");
    expect(resolved).toHaveLength(1);
    expect(resolved[0].vaultFile).toBe(file);
    expect(resolved[0].targetFilename).toBe("shot.png");
    expect(resolved[0].ref.raw).toBe("![[shot.png]]");
  });

  it("drops refs that cannot be resolved", () => {
    const app = makeApp({ "shot.png": null });
    const refs = collectMarkdownImageRefs("![[shot.png]]");
    const resolved = resolveImageRefs(refs, app as never, "Notes/note.md");
    expect(resolved).toHaveLength(0);
  });

  it("uses the file's name as targetFilename (not the linkpath)", () => {
    const file = makeTFile("diagram.svg");
    // Linkpath may omit the folder; file.name is authoritative.
    const app = makeApp({ "diagram.svg": file });
    const refs = collectMarkdownImageRefs("![[diagram.svg]]");
    const resolved = resolveImageRefs(refs, app as never, "Notes/note.md");
    expect(resolved[0].targetFilename).toBe("diagram.svg");
  });

  it("resolves multiple refs independently", () => {
    const a = makeTFile("a.png");
    const b = makeTFile("b.jpg");
    const app = makeApp({ "a.png": a, "b.jpg": b });
    const refs = collectMarkdownImageRefs("![[a.png]] ![[b.jpg]]");
    const resolved = resolveImageRefs(refs, app as never, "note.md");
    expect(resolved.map((r) => r.targetFilename)).toEqual(["a.png", "b.jpg"]);
  });
});

function base64Encode(bytes: Uint8Array): string {
  // Use Buffer in the node/vitest environment.
  return Buffer.from(bytes).toString("base64");
}

describe("rewriteMarkdownEmbedsToPlainImg", () => {
  it("converts a wikilink embed to standard markdown image", () => {
    const md = "before ![[shot.png]] after";
    const out = rewriteMarkdownEmbedsToPlainImg(md, [
      { raw: "![[shot.png]]", alt: "", targetFilename: "shot.png" },
    ]);
    expect(out).toBe("before ![](shot.png) after");
  });

  it("preserves alt text from a piped wikilink", () => {
    const md = "![[shot.png|My Shot]]";
    const out = rewriteMarkdownEmbedsToPlainImg(md, [
      { raw: "![[shot.png|My Shot]]", alt: "My Shot", targetFilename: "shot.png" },
    ]);
    expect(out).toBe("![My Shot](shot.png)");
  });

  it("normalises a standard markdown image path to bare filename", () => {
    const md = "![cap](sub/dir/img.jpg)";
    const out = rewriteMarkdownEmbedsToPlainImg(md, [
      { raw: "![cap](sub/dir/img.jpg)", alt: "cap", targetFilename: "img.jpg" },
    ]);
    expect(out).toBe("![cap](img.jpg)");
  });

  it("replaces all occurrences of the same token", () => {
    const md = "![[a.png]] and again ![[a.png]]";
    const out = rewriteMarkdownEmbedsToPlainImg(md, [
      { raw: "![[a.png]]", alt: "", targetFilename: "a.png" },
    ]);
    expect(out).toBe("![](a.png) and again ![](a.png)");
  });

  it("leaves unrelated text untouched", () => {
    const md = "# Title\n\nBody.\n";
    expect(rewriteMarkdownEmbedsToPlainImg(md, [])).toBe(md);
  });

  it("URL-encodes spaces in targetFilename so marked can parse the URL", () => {
    const md = "before ![[Pasted image 20260413.png]] after";
    const out = rewriteMarkdownEmbedsToPlainImg(md, [
      { raw: "![[Pasted image 20260413.png]]", alt: "", targetFilename: "Pasted image 20260413.png" },
    ]);
    expect(out).toBe("before ![](Pasted%20image%2020260413.png) after");
  });
});

describe("rewriteHtmlToAttachmentMacros", () => {
  it("replaces a plain img tag with an ac:image macro", () => {
    const html = '<p><img src="shot.png" alt=""></p>';
    const out = rewriteHtmlToAttachmentMacros(html, { "shot.png": "shot.png" });
    expect(out.html).toBe(
      '<p><ac:image><ri:attachment ri:filename="shot.png" /></ac:image></p>',
    );
    expect(out.unresolved).toEqual([]);
  });

  it("includes alt text as ac:alt", () => {
    const html = '<img src="shot.png" alt="My Shot">';
    const out = rewriteHtmlToAttachmentMacros(html, { "shot.png": "shot.png" });
    expect(out.html).toBe(
      '<ac:image ac:alt="My Shot"><ri:attachment ri:filename="shot.png" /></ac:image>',
    );
  });

  it("maps base64 src to a hashed filename", () => {
    const html =
      '<img src="data:image/png;base64,QUFBQQ==" alt="x">';
    const out = rewriteHtmlToAttachmentMacros(html, {
      "data:image/png;base64,QUFBQQ==": "abc123def456.png",
    });
    expect(out.html).toContain('ri:filename="abc123def456.png"');
    expect(out.html).not.toContain("data:image");
  });

  it("leaves unmapped images alone and reports them", () => {
    const html = '<img src="missing.png">';
    const out = rewriteHtmlToAttachmentMacros(html, {});
    expect(out.html).toBe('<img src="missing.png">');
    expect(out.unresolved).toEqual(["missing.png"]);
  });

  it("handles self-closing img tags", () => {
    const html = '<img src="a.png" />';
    const out = rewriteHtmlToAttachmentMacros(html, { "a.png": "a.png" });
    expect(out.html).toBe('<ac:image><ri:attachment ri:filename="a.png" /></ac:image>');
  });

  it("handles multiple images in one document", () => {
    const html =
      '<p><img src="a.png" alt="A"><img src="b.jpg" alt=""></p>';
    const out = rewriteHtmlToAttachmentMacros(html, {
      "a.png": "a.png",
      "b.jpg": "b.jpg",
    });
    expect(out.html).toBe(
      '<p><ac:image ac:alt="A"><ri:attachment ri:filename="a.png" /></ac:image>' +
        '<ac:image><ri:attachment ri:filename="b.jpg" /></ac:image></p>',
    );
  });

  it("escapes XML special chars in filename and alt", () => {
    const html = '<img src="orig" alt="A & B">';
    const out = rewriteHtmlToAttachmentMacros(html, { orig: "x&y.png" });
    expect(out.html).toContain('ri:filename="x&amp;y.png"');
    expect(out.html).toContain('ac:alt="A &amp; B"');
  });

  it("includes ac:width when a width is specified", () => {
    const html = '<img src="shot.png" alt="">';
    const out = rewriteHtmlToAttachmentMacros(html, { "shot.png": "shot.png" }, 800);
    expect(out.html).toBe('<ac:image ac:width="800"><ri:attachment ri:filename="shot.png" /></ac:image>');
  });

  it("omits ac:width when no width is given", () => {
    const html = '<img src="shot.png" alt="">';
    const out = rewriteHtmlToAttachmentMacros(html, { "shot.png": "shot.png" });
    expect(out.html).toBe('<ac:image><ri:attachment ri:filename="shot.png" /></ac:image>');
  });

  it("places ac:width before ac:alt when both are present", () => {
    const html = '<img src="shot.png" alt="caption">';
    const out = rewriteHtmlToAttachmentMacros(html, { "shot.png": "shot.png" }, 600);
    expect(out.html).toBe('<ac:image ac:width="600" ac:alt="caption"><ri:attachment ri:filename="shot.png" /></ac:image>');
  });
});
