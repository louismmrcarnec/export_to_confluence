export interface MultipartBody {
  body: ArrayBuffer;
  boundary: string;
}

/**
 * Build a multipart/form-data body containing a single file field named
 * "file". Returns the bytes plus the boundary string for the Content-Type
 * header. The bytes are returned as ArrayBuffer so they can be passed to
 * Obsidian's `requestUrl` body parameter.
 */
export function buildMultipartFileBody(
  filename: string,
  bytes: Uint8Array,
  contentType: string,
): MultipartBody {
  const boundary = makeBoundary();

  const headerText =
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
    `Content-Type: ${contentType}\r\n` +
    `\r\n`;
  const trailerText = `\r\n--${boundary}--\r\n`;

  const enc = new TextEncoder();
  const headerBytes = enc.encode(headerText);
  const trailerBytes = enc.encode(trailerText);

  const total = headerBytes.length + bytes.length + trailerBytes.length;
  const buf = new Uint8Array(total);
  buf.set(headerBytes, 0);
  buf.set(bytes, headerBytes.length);
  buf.set(trailerBytes, headerBytes.length + bytes.length);

  return { body: buf.buffer, boundary };
}

function makeBoundary(): string {
  const rand = Math.random().toString(16).slice(2);
  return `----obsidianConfluenceBoundary${rand}`;
}
