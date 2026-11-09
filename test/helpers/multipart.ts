// Builds multipart/form-data payloads for upload tests (task 4.4).
export interface MultipartPart {
  readonly name: string;
  /** Present for a file part; absent for a plain field. */
  readonly filename?: string;
  readonly content: string | Buffer;
  readonly contentType?: string;
}

const BOUNDARY = '----test-boundary-7MA4YWxkTrZu0gW';

export function multipart(parts: readonly MultipartPart[]): {
  headers: Record<string, string>;
  payload: Buffer;
} {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition =
      part.filename === undefined
        ? `form-data; name="${part.name}"`
        : `form-data; name="${part.name}"; filename="${part.filename}"`;
    const type = part.filename === undefined ? '' : `Content-Type: ${part.contentType ?? 'text/csv'}\r\n`;
    chunks.push(Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: ${disposition}\r\n${type}\r\n`));
    chunks.push(typeof part.content === 'string' ? Buffer.from(part.content) : part.content);
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${BOUNDARY}--\r\n`));
  return {
    headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
    payload: Buffer.concat(chunks),
  };
}
