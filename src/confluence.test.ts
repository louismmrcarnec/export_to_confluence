import { describe, it, expect, vi, beforeEach } from "vitest";
import { requestUrl } from "obsidian";
import { ConfluenceClient, PageMissingError, PageExistsError, AttachmentUploadFn } from "./confluence";

const mockRequest = vi.mocked(requestUrl);

const mockUpload = vi.fn<Parameters<AttachmentUploadFn>, ReturnType<AttachmentUploadFn>>();

const CLIENT = new ConfluenceClient({
  baseUrl: "https://example.atlassian.net/wiki/rest/api",
  authHeader: "Basic dXNlcjp0b2tlbg==",
  attachmentUpload: mockUpload,
});

function ok(json: unknown) {
  return Promise.resolve({
    status: 200,
    json,
    text: JSON.stringify(json),
    headers: {},
    arrayBuffer: new ArrayBuffer(0),
  });
}

function fail(status: number, text = "") {
  return Promise.resolve({
    status,
    json: null,
    text,
    headers: {},
    arrayBuffer: new ArrayBuffer(0),
  });
}

beforeEach(() => {
  mockRequest.mockReset();
  mockUpload.mockReset();
});

// ---- createPage -------------------------------------------------------

describe("ConfluenceClient.createPage", () => {
  it("POSTs to /content with correct body and returns page id", async () => {
    mockRequest.mockResolvedValueOnce({
      status: 200,
      json: { id: "123" },
      text: '{"id":"123"}',
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
    });

    const id = await CLIENT.createPage({
      title: "My Page",
      spaceKey: "DOC",
      html: "<p>Hello</p>",
      parentId: "456",
    });

    expect(id).toBe("123");
    const call = mockRequest.mock.calls[0][0];
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://example.atlassian.net/wiki/rest/api/content");
    expect(call.headers?.["Authorization"]).toBe("Basic dXNlcjp0b2tlbg==");
    const body = JSON.parse(call.body as string);
    expect(body.title).toBe("My Page");
    expect(body.space.key).toBe("DOC");
    expect(body.body.storage.value).toBe("<p>Hello</p>");
    expect(body.ancestors).toEqual([{ id: "456" }]);
  });

  it("omits ancestors when parentId is empty", async () => {
    mockRequest.mockResolvedValueOnce({
      status: 200,
      json: { id: "7" },
      text: '{"id":"7"}',
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
    });
    await CLIENT.createPage({ title: "T", spaceKey: "S", html: "", parentId: "" });
    const body = JSON.parse(mockRequest.mock.calls[0][0].body as string);
    expect(body.ancestors).toBeUndefined();
  });

  it("throws an error with status on non-2xx", async () => {
    mockRequest.mockResolvedValueOnce(await fail(400, "Bad request") as any);
    await expect(
      CLIENT.createPage({ title: "T", spaceKey: "S", html: "", parentId: "" }),
    ).rejects.toThrow("400");
  });

  it("throws PageExistsError when Confluence returns 400 with 'already exists' in the body", async () => {
    mockRequest.mockResolvedValueOnce(
      await fail(400, '{"message":"A page already exists with this title in this space"}') as any,
    );
    await expect(
      CLIENT.createPage({ title: "My Page", spaceKey: "DOC", html: "", parentId: "" }),
    ).rejects.toThrow(PageExistsError);
  });
});

// ---- getPageByTitle --------------------------------------------------

describe("ConfluenceClient.getPageByTitle", () => {
  it("GETs /content?title=...&spaceKey=...&type=page and returns the first result id", async () => {
    mockRequest.mockResolvedValueOnce(ok({ results: [{ id: "42" }] }));

    const id = await CLIENT.getPageByTitle("DOC", "My Page");

    expect(id).toBe("42");
    const call = mockRequest.mock.calls[0][0];
    expect(call.method).toBe("GET");
    expect(call.url).toContain("title=My%20Page");
    expect(call.url).toContain("spaceKey=DOC");
    expect(call.url).toContain("type=page");
  });

  it("returns null when no page matches", async () => {
    mockRequest.mockResolvedValueOnce(ok({ results: [] }));
    expect(await CLIENT.getPageByTitle("DOC", "Missing Page")).toBeNull();
  });

  it("throws on non-2xx", async () => {
    mockRequest.mockResolvedValueOnce(await fail(500, "Server error") as any);
    await expect(CLIENT.getPageByTitle("DOC", "T")).rejects.toThrow("500");
  });
});

// ---- updatePage -------------------------------------------------------

describe("ConfluenceClient.updatePage", () => {
  it("GETs version, increments, then PUTs", async () => {
    mockRequest
      .mockResolvedValueOnce({
        status: 200,
        json: { version: { number: 3 } },
        text: '{"version":{"number":3}}',
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: { id: "99" },
        text: '{"id":"99"}',
        headers: {},
        arrayBuffer: new ArrayBuffer(0),
      });

    const id = await CLIENT.updatePage({
      pageId: "99",
      title: "T",
      spaceKey: "S",
      html: "<p>v2</p>",
      parentId: "",
    });

    expect(id).toBe("99");
    const [get, put] = mockRequest.mock.calls;
    expect(get[0].method).toBe("GET");
    expect(get[0].url).toContain("/content/99");
    expect(put[0].method).toBe("PUT");
    const putBody = JSON.parse(put[0].body as string);
    expect(putBody.version.number).toBe(4);
    expect(putBody.body.storage.value).toBe("<p>v2</p>");
  });

  it("throws PageMissingError on 404", async () => {
    mockRequest.mockResolvedValueOnce(await fail(404) as any);
    await expect(
      CLIENT.updatePage({ pageId: "99", title: "T", spaceKey: "S", html: "", parentId: "" }),
    ).rejects.toThrow(PageMissingError);
  });

  it("throws generic error on other non-2xx", async () => {
    mockRequest.mockResolvedValueOnce(await fail(503, "Service unavailable") as any);
    await expect(
      CLIENT.updatePage({ pageId: "1", title: "T", spaceKey: "S", html: "", parentId: "" }),
    ).rejects.toThrow("503");
  });
});

// ---- listAttachments -------------------------------------------------

describe("ConfluenceClient.listAttachments", () => {
  it("GETs /content/{id}/child/attachment and returns title+id pairs", async () => {
    mockRequest.mockResolvedValueOnce({
      status: 200,
      json: { results: [{ id: "a1", title: "img.png" }, { id: "a2", title: "doc.pdf" }] },
      text: "",
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
    });

    const list = await CLIENT.listAttachments("42");
    expect(list).toEqual([
      { id: "a1", title: "img.png" },
      { id: "a2", title: "doc.pdf" },
    ]);
    expect(mockRequest.mock.calls[0][0].url).toContain("/content/42/child/attachment");
  });

  it("returns empty array when results is missing", async () => {
    mockRequest.mockResolvedValueOnce({
      status: 200,
      json: {},
      text: "",
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
    });
    expect(await CLIENT.listAttachments("1")).toEqual([]);
  });
});

// ---- getPageTitle ----------------------------------------------------

describe("ConfluenceClient.getPageTitle", () => {
  it("GETs /content/{id} and returns the page title", async () => {
    mockRequest.mockResolvedValueOnce(ok({ id: "42", title: "My Page" }));

    const title = await CLIENT.getPageTitle("42");

    expect(title).toBe("My Page");
    const call = mockRequest.mock.calls[0][0];
    expect(call.method).toBe("GET");
    expect(call.url).toContain("/content/42");
  });

  it("throws PageMissingError on 404", async () => {
    mockRequest.mockResolvedValueOnce(await fail(404) as any);
    await expect(CLIENT.getPageTitle("42")).rejects.toThrow(PageMissingError);
  });

  it("throws on other non-2xx", async () => {
    mockRequest.mockResolvedValueOnce(await fail(500, "Server error") as any);
    await expect(CLIENT.getPageTitle("42")).rejects.toThrow("500");
  });
});

// ---- uploadAttachment ------------------------------------------------

describe("ConfluenceClient.uploadAttachment", () => {
  it("calls the upload transport with correct URL, headers, and multipart body", async () => {
    mockUpload.mockResolvedValueOnce(undefined);

    await CLIENT.uploadAttachment("42", "shot.png", new Uint8Array([1, 2, 3]), "image/png");

    expect(mockUpload).toHaveBeenCalledTimes(1);
    const [url, body, headers] = mockUpload.mock.calls[0];
    expect(url).toContain("/content/42/child/attachment");
    expect(headers["X-Atlassian-Token"]).toBe("nocheck");
    expect(headers["Content-Type"]).toMatch(/^multipart\/form-data;\s*boundary=/);
    expect(body).toBeInstanceOf(Buffer);
  });

  it("propagates errors from the upload transport", async () => {
    mockUpload.mockRejectedValueOnce(new Error("HTTP 413 Too large"));
    await expect(
      CLIENT.uploadAttachment("1", "f.png", new Uint8Array([1]), "image/png"),
    ).rejects.toThrow("413");
  });
});
