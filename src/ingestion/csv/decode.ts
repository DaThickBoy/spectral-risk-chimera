/**
 * Incremental UTF-8 decoding for CSV parsing (task 7.1; R28.3).
 *
 * The input is read in fixed-size `subarray` views (no byte copies). Each view is
 * decoded with a fatal `TextDecoder` in streaming mode, so a multi-byte
 * character split across chunk boundaries is decoded correctly and any invalid
 * sequence throws. The decoder strips a leading UTF-8 BOM once, at the start of
 * the stream (`ignoreBOM: false`). No string larger than one chunk's text is
 * ever built here.
 */

/** Bytes per decoding step. */
export const DECODE_CHUNK_BYTES = 64 * 1024;

/** Decoded text chunks of `input`; throws `TypeError` on invalid UTF-8. */
export function* utf8Chunks(input: Uint8Array): Generator<string> {
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  for (let offset = 0; offset < input.length; offset += DECODE_CHUNK_BYTES) {
    const text = decoder.decode(input.subarray(offset, offset + DECODE_CHUNK_BYTES), { stream: true });
    if (text.length > 0) {
      yield text;
    }
  }
  const tail = decoder.decode();
  if (tail.length > 0) {
    yield tail;
  }
}

/** True when `input` is valid UTF-8 (decoded chunk by chunk and discarded). */
export function isValidUtf8(input: Uint8Array): boolean {
  try {
    for (const chunk of utf8Chunks(input)) {
      void chunk;
    }
    return true;
  } catch (error) {
    if (error instanceof TypeError) {
      return false;
    }
    throw error;
  }
}
