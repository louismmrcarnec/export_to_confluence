import { describe, it, expect } from "vitest";
import { buildMultipartFileBody } from "./multipart";

function bytesToString(bytes: ArrayBuffer): string {
  return new TextDecoder("latin1").decode(bytes);
}

describe("buildMultipartFileBody", () => {
  it("returns an ArrayBuffer body and a boundary string", () => {
    const out = buildMultipartFileBody(
      "shot.png",
      new Uint8Array([1, 2, 3]),
      "image/png",
    );
    expect(out.body).toBeInstanceOf(ArrayBuffer);
    expect(typeof out.boundary).toBe("string");
    expect(out.boundary.length).toBeGreaterThan(0);
  });

  it("includes the boundary delimiter twice (open + close)", () => {
    const out = buildMultipartFileBody(
      "a.png",
      new Uint8Array([0xff]),
      "image/png",
    );
    const text = bytesToString(out.body);
    const open = text.indexOf(`--${out.boundary}\r\n`);
    const close = text.indexOf(`--${out.boundary}--\r\n`);
    expect(open).toBeGreaterThanOrEqual(0);
    expect(close).toBeGreaterThan(open);
  });

  it("includes Content-Disposition with name=file and the filename", () => {
    const out = buildMultipartFileBody(
      "Pretty Name.png",
      new Uint8Array([0x00]),
      "image/png",
    );
    const text = bytesToString(out.body);
    expect(text).toContain(
      'Content-Disposition: form-data; name="file"; filename="Pretty Name.png"',
    );
  });

  it("includes the supplied Content-Type header", () => {
    const out = buildMultipartFileBody(
      "x.jpg",
      new Uint8Array([1]),
      "image/jpeg",
    );
    expect(bytesToString(out.body)).toContain("Content-Type: image/jpeg");
  });

  it("preserves binary payload bytes verbatim between headers and closing delimiter", () => {
    const payload = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0x42]);
    const out = buildMultipartFileBody("p.png", payload, "image/png");
    const view = new Uint8Array(out.body);

    // Find a `\r\n\r\n` (CRLF CRLF) marking end of headers.
    let headersEnd = -1;
    for (let i = 0; i < view.length - 3; i++) {
      if (
        view[i] === 0x0d && view[i + 1] === 0x0a &&
        view[i + 2] === 0x0d && view[i + 3] === 0x0a
      ) {
        headersEnd = i + 4;
        break;
      }
    }
    expect(headersEnd).toBeGreaterThan(0);
    const recovered = view.slice(headersEnd, headersEnd + payload.length);
    expect(Array.from(recovered)).toEqual(Array.from(payload));
  });

  it("ends with CRLF after closing boundary", () => {
    const out = buildMultipartFileBody(
      "x.png",
      new Uint8Array([1]),
      "image/png",
    );
    const text = bytesToString(out.body);
    expect(text.endsWith(`--${out.boundary}--\r\n`)).toBe(true);
  });
});
