/**
 * Safe upload handling (task 4.4; design: API gateway, uploads; R28.4, R29.6,
 * AT-SEC-25, AT-CSV-08 size part).
 *
 * - Multipart uploads are streamed into memory and capped at
 *   `import.maxFileBytes` by the multipart parser itself: a larger file is
 *   rejected with `FILE_TOO_LARGE` as soon as the limit is crossed, before any
 *   content is parsed or returned.
 * - Exactly one file part and no other parts are accepted; anything else is
 *   `UPLOAD_INVALID`. A request that is not multipart is
 *   `UNSUPPORTED_MEDIA_TYPE`.
 * - The client filename is never used to build a file system path; this module
 *   performs no file system access at all. It is reduced to a display-safe
 *   `originalName` (`sanitizeFilename`), and every upload is identified by a
 *   generated `storedName` from the injected `IdGenerator`.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { IdGenerator } from '../shared/index.js';
import { sendError } from './errors.js';

export interface UploadLimits {
  /** `import.maxFileBytes`: positive integer. */
  readonly maxFileBytes: number;
}

export interface ReceivedUpload {
  /** Generated identifier; the only name under which the upload is kept. */
  readonly storedName: string;
  /** Sanitized client filename, for display and audit only. */
  readonly originalName: string;
  readonly mimeType: string;
  readonly bytes: Buffer;
  readonly size: number;
}

export type UploadRejection = 'FILE_TOO_LARGE' | 'UPLOAD_INVALID' | 'UNSUPPORTED_MEDIA_TYPE';

export type UploadResult =
  | { readonly ok: true; readonly upload: ReceivedUpload }
  | { readonly ok: false; readonly reason: UploadRejection };

const MAX_NAME_LENGTH = 128;
const FALLBACK_NAME = 'upload';

/**
 * A display-safe filename: the last path segment (both `/` and `\`), with
 * control characters removed, every character outside `[A-Za-z0-9._ -]`
 * replaced by `_`, leading dots and spaces removed (no hidden or relative
 * names), and at most 128 characters. An empty result becomes `upload`.
 */
export function sanitizeFilename(name: unknown): string {
  if (typeof name !== 'string') {
    return FALLBACK_NAME;
  }
  const lastSegment = name.split(/[/\\]/).pop() ?? '';
  const cleaned = lastSegment
    .normalize('NFC')
    .replace(/\p{Cc}/gu, '')
    .replace(/[^A-Za-z0-9._ -]/g, '_')
    .replace(/^[. ]+/, '')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
  return cleaned.length === 0 || cleaned === '.' || cleaned === '..' ? FALLBACK_NAME : cleaned;
}

/** Multipart parser options for `createApiServer` (one file, no fields). */
export function multipartOptions(limits: UploadLimits) {
  if (!Number.isSafeInteger(limits.maxFileBytes) || limits.maxFileBytes <= 0) {
    throw new TypeError('maxFileBytes must be a positive integer.');
  }
  return {
    throwFileSizeLimit: true,
    limits: {
      fileSize: limits.maxFileBytes,
      files: 1,
      fields: 0,
      parts: 1,
      fieldNameSize: 100,
      headerPairs: 100,
    },
  } as const;
}

const REJECTIONS: Readonly<Record<string, UploadRejection>> = {
  FST_REQ_FILE_TOO_LARGE: 'FILE_TOO_LARGE',
  FST_PARTS_LIMIT: 'UPLOAD_INVALID',
  FST_FILES_LIMIT: 'UPLOAD_INVALID',
  FST_FIELDS_LIMIT: 'UPLOAD_INVALID',
  FST_PROTO_VIOLATION: 'UPLOAD_INVALID',
  FST_MP_PREMATURE_CLOSE: 'UPLOAD_INVALID',
  FST_INVALID_MULTIPART_CONTENT_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
};

/** Reads the single uploaded file of a multipart request into memory, within the limit. */
export async function receiveUpload(request: FastifyRequest, ids: IdGenerator): Promise<UploadResult> {
  if (!request.isMultipart()) {
    return { ok: false, reason: 'UNSUPPORTED_MEDIA_TYPE' };
  }
  let received: ReceivedUpload | undefined;
  let invalid = false;
  try {
    for await (const part of request.parts()) {
      if (part.type !== 'file' || received !== undefined) {
        invalid = true;
        if (part.type === 'file') {
          part.file.resume(); // drain an unexpected part
        }
        continue;
      }
      const bytes = await part.toBuffer(); // throws FST_REQ_FILE_TOO_LARGE past the limit
      received = Object.freeze({
        storedName: ids.next(),
        originalName: sanitizeFilename(part.filename),
        mimeType: part.mimetype,
        bytes,
        size: bytes.length,
      });
    }
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    const reason = typeof code === 'string' ? REJECTIONS[code] : undefined;
    if (reason !== undefined) {
      return { ok: false, reason };
    }
    throw error;
  }
  if (invalid || received === undefined) {
    return { ok: false, reason: 'UPLOAD_INVALID' };
  }
  return { ok: true, upload: received };
}

const STATUS: Readonly<Record<UploadRejection, { status: number; message: string }>> = {
  FILE_TOO_LARGE: { status: 413, message: 'The uploaded file is too large.' },
  UPLOAD_INVALID: { status: 400, message: 'The upload must contain exactly one file.' },
  UNSUPPORTED_MEDIA_TYPE: { status: 415, message: 'The content type is not supported.' },
};

/** Sends an upload rejection in the gateway error shape. */
export function sendUploadRejection(
  reply: FastifyReply,
  request: FastifyRequest,
  reason: UploadRejection,
): FastifyReply {
  const { status, message } = STATUS[reason];
  return sendError(reply, request, status, reason, message);
}
