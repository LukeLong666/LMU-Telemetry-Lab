import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PathSafety } from '../../../src/infra/fs/path-safety.js';
import { ApiException } from '../../../src/api/error.js';

/** Ported from backend-java/src/test/java/com/lmutl/infra/fs/PathSafetyTest.java. */
describe('PathSafety', () => {
  let root = '';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'lmutl-test-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it('resolves a relative path under the root', () => {
    const resolved = PathSafety.resolveUnder(root, 'session.duckdb');
    expect(path.dirname(resolved)).toBe(path.resolve(root));
  });

  it('rejects traversal and absolute paths', () => {
    // Java used a literal backslash separator; path.sep keeps the same intent on POSIX.
    expect(() => PathSafety.resolveUnder(root, `..${path.sep}outside.duckdb`)).toThrow(ApiException);
    expect(() => PathSafety.resolveUnder(root, 'C:\\Windows\\evil.duckdb')).toThrow(ApiException);
  });

  it('sanitizes file names', () => {
    expect(PathSafety.safeFileName(`..${path.sep}evil.duckdb`)).toBe('evil.duckdb');
    expect(PathSafety.isDuckDb('SESSION.DUCKDB')).toBe(true);
    expect(PathSafety.stripDuckDb('session.duckdb')).toBe('session');
  });
});
