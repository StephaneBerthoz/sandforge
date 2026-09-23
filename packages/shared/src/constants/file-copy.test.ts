import { describe, it, expect } from 'vitest';
import {
  BYTES_PER_MB,
  FILE_COPY_CEILING_MB,
  FILE_COPY_DEFAULT_MAX_MB,
  fileCopyRefusal,
} from './file-copy.js';

describe('the size a file is copied up to', () => {
  it('starts at ten megabytes, under the ceiling', () => {
    expect(FILE_COPY_DEFAULT_MAX_MB).toBe(10);
    expect(FILE_COPY_DEFAULT_MAX_MB).toBeLessThan(FILE_COPY_CEILING_MB);
  });

  it('never lets a file past what one JSON call carries once base64 has grown it', () => {
    // 50 MB of text per non-multipart call, the megabyte counted either way.
    const encoded = Math.ceil((FILE_COPY_CEILING_MB * BYTES_PER_MB) / 3) * 4;
    expect(encoded).toBeLessThan(50 * 1_000_000);
    expect(encoded).toBeLessThan(50 * BYTES_PER_MB);
  });
});

describe('fileCopyRefusal', () => {
  it('lets a run that anonymizes nothing copy its files', () => {
    expect(fileCopyRefusal(false, false)).toBeNull();
  });

  it('refuses a run that anonymizes until files are accepted as they are', () => {
    const refusal = fileCopyRefusal(true, false);

    expect(refusal).toContain('copied as they are');
    expect(refusal).toContain('Nothing was read or written');
    expect(fileCopyRefusal(true, true)).toBeNull();
  });
});
