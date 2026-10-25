import path from 'node:path';
import { ApiException } from '../../api/error.js';

const DUCKDB_SUFFIX = '.duckdb';

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/** Traversal guard for every client-supplied relative path. Mirrors PathSafety.java. */
export const PathSafety = {
  resolveUnder(root: string, child: string): string {
    if (child === undefined || child.trim() === '') {
      throw new ApiException(400, 'Path is required');
    }
    const trimmed = child.trim();
    if (trimmed.includes('\0')) {
      throw new ApiException(400, 'Invalid path');
    }
    if (path.isAbsolute(trimmed) || /^[a-zA-Z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\')) {
      throw new ApiException(400, 'Absolute paths are not allowed here');
    }
    const normalizedRoot = path.resolve(root);
    const candidate = path.resolve(normalizedRoot, trimmed);
    if (candidate === normalizedRoot || !isInside(normalizedRoot, candidate)) {
      throw new ApiException(400, 'Path escapes the data directory');
    }
    return candidate;
  },

  safeFileName(name: string): string {
    if (name === undefined || name.trim() === '') {
      throw new ApiException(400, 'File name is required');
    }
    const trimmed = name.trim();
    if (trimmed.includes('\0')) {
      throw new ApiException(400, 'Invalid file name');
    }
    const fileName = path.basename(trimmed);
    if (fileName === '' || fileName === '.' || fileName === '..') {
      throw new ApiException(400, 'Invalid file name');
    }
    return fileName;
  },

  isDuckDb(fileName: string): boolean {
    return fileName !== undefined && fileName !== null && fileName.toLowerCase().endsWith(DUCKDB_SUFFIX);
  },

  stripDuckDb(fileName: string | undefined): string {
    if (fileName === undefined || fileName === null) return '';
    return fileName.toLowerCase().endsWith(DUCKDB_SUFFIX)
      ? fileName.slice(0, fileName.length - DUCKDB_SUFFIX.length)
      : fileName;
  },
};
