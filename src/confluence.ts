import { requestUrl, RequestUrlResponse } from "obsidian";
import { buildMultipartFileBody } from "./multipart";
import * as https from "https";
import { URL } from "url";

export class PageMissingError extends Error {
  constructor(pageId: string) {
    super(`Confluence page ${pageId} not found (404). It may have been deleted.`);
    this.name = "PageMissingError";
  }
}

export class PageExistsError extends Error {
  constructor(title: string) {
    super(`A page with title "${title}" already exists in this space.`);
    this.name = "PageExistsError";
  }
}

// Injectable transport for attachment upload (default: Node.js https).
// Exposed so tests can swap it without having to spy on built-ins.
export type AttachmentUploadFn = (
  url: string,
  body: Buffer,
  headers: Record<string, string>,
) => Promise<void>;

interface ClientConfig {
  baseUrl: string;
  authHeader: string;
  attachmentUpload?: AttachmentUploadFn;
}

interface CreatePageParams {
  title: string;
  spaceKey: string;
  html: string;
  parentId: string;
}

interface UpdatePageParams {
  pageId: string;
  title: string;
  spaceKey: string;
  html: string;
  parentId: string;
}

export interface AttachmentInfo {
  id: string;
  title: string;
}

export class ConfluenceClient {
  private baseUrl: string;
  private authHeader: string;
  private attachmentUpload: AttachmentUploadFn;

  constructor(config: ClientConfig) {
    this.baseUrl = config.baseUrl;
    this.authHeader = config.authHeader;
    this.attachmentUpload = config.attachmentUpload ?? httpsPost;
  }

  async createPage(params: CreatePageParams): Promise<string> {
    const { title, spaceKey, html, parentId } = params;
    const payload: Record<string, unknown> = {
      type: "page",
      title,
      space: { key: spaceKey },
      body: { storage: { value: html, representation: "storage" } },
    };
    if (parentId) payload.ancestors = [{ id: parentId }];

    const resp = await this.request("POST", "/content", payload);
    if (resp.status === 400 && /already exists/i.test(resp.text ?? "")) {
      throw new PageExistsError(title);
    }
    assertOk(resp, "create page");
    return String((resp.json as Record<string, unknown>).id);
  }

  async updatePage(params: UpdatePageParams): Promise<string> {
    const { pageId, title, spaceKey, html, parentId } = params;

    const getResp = await this.request(
      "GET",
      `/content/${encodeURIComponent(pageId)}?expand=version`,
    );
    if (getResp.status === 404) throw new PageMissingError(pageId);
    assertOk(getResp, "fetch page version");

    const currentVersion = Number(
      ((getResp.json as Record<string, unknown>)?.version as Record<string, unknown>)?.number ?? 0,
    );

    const payload: Record<string, unknown> = {
      id: pageId,
      type: "page",
      title,
      space: { key: spaceKey },
      version: { number: currentVersion + 1 },
      body: { storage: { value: html, representation: "storage" } },
    };
    if (parentId) payload.ancestors = [{ id: parentId }];

    const putResp = await this.request(
      "PUT",
      `/content/${encodeURIComponent(pageId)}`,
      payload,
    );
    assertOk(putResp, "update page");
    return String((putResp.json as Record<string, unknown>).id);
  }

  async getPageTitle(pageId: string): Promise<string> {
    const resp = await this.request("GET", `/content/${encodeURIComponent(pageId)}`);
    if (resp.status === 404) throw new PageMissingError(pageId);
    assertOk(resp, "get page title");
    return String((resp.json as Record<string, unknown>).title ?? "");
  }

  async getPageByTitle(spaceKey: string, title: string): Promise<string | null> {
    const path = `/content?title=${encodeURIComponent(title)}&spaceKey=${encodeURIComponent(spaceKey)}&type=page`;
    const resp = await this.request("GET", path);
    assertOk(resp, "search page by title");
    const results = ((resp.json as Record<string, unknown>)?.results ?? []) as Array<{ id: string }>;
    if (results.length === 0) return null;
    return String(results[0].id);
  }

  async listAttachments(pageId: string): Promise<AttachmentInfo[]> {
    const resp = await this.request(
      "GET",
      `/content/${encodeURIComponent(pageId)}/child/attachment`,
    );
    assertOk(resp, "list attachments");
    const results = ((resp.json as Record<string, unknown>)?.results ?? []) as AttachmentInfo[];
    return results.map((r) => ({ id: String(r.id), title: String(r.title) }));
  }

  async uploadAttachment(
    pageId: string,
    filename: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void> {
    // Use Node.js https directly: requestUrl strips X-Atlassian-Token for
    // multipart bodies; fetch() is blocked by CORS from app://obsidian.md.
    // Node.js https is available in Obsidian's renderer (nodeIntegration enabled).
    const { body, boundary } = buildMultipartFileBody(filename, bytes, contentType);
    const url = `${this.baseUrl}/content/${encodeURIComponent(pageId)}/child/attachment`;

    await this.attachmentUpload(url, Buffer.from(body), {
      Authorization: this.authHeader,
      "X-Atlassian-Token": "nocheck",
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      Accept: "application/json",
    });
  }

  private async request(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
  ): Promise<RequestUrlResponse> {
    return requestUrl({
      url: this.baseUrl + path,
      method,
      contentType: "application/json",
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      throw: false,
    });
  }
}

function assertOk(resp: RequestUrlResponse, action: string): void {
  if (resp.status < 200 || resp.status >= 300) {
    throw new Error(
      `Confluence ${action} failed: HTTP ${resp.status} ${resp.text ?? ""}`.trim(),
    );
  }
}

/**
 * Minimal HTTPS POST using Node.js net stack. Bypasses both CORS (unlike fetch)
 * and requestUrl's multipart header handling quirks.
 */
function httpsPost(
  rawUrl: string,
  body: Buffer,
  headers: Record<string, string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(rawUrl);
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: "POST",
        headers: { ...headers, "Content-Length": body.byteLength },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            const text = Buffer.concat(chunks).toString("utf8");
            reject(
              new Error(`Confluence upload attachment failed: HTTP ${status} ${text}`.trim()),
            );
          } else {
            resolve();
          }
        });
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}
