import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

function tempSibling(target: string): string {
  const dir = path.dirname(target);
  const base = path.basename(target);
  return path.join(dir, `${base}.${crypto.randomBytes(6).toString('hex')}.tmp`);
}

async function moveIntoPlace(source: string, target: string): Promise<void> {
  try {
    await fs.promises.rename(source, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Windows refuses to rename onto an existing file; POSIX rename already covers it.
    if (code === 'EPERM' || code === 'ENOTEMPTY' || code === 'EEXIST') {
      await fs.promises.rm(target, { force: true, recursive: false });
      await fs.promises.rename(source, target);
      return;
    }
    throw error;
  }
}

async function withTempWrite<T>(target: string, write: (temp: string) => Promise<T>): Promise<T> {
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const temp = tempSibling(target);
  try {
    const result = await write(temp);
    await moveIntoPlace(temp, target);
    return result;
  } finally {
    await fs.promises.rm(temp, { force: true });
  }
}

/**
 * Writes that never leave a half-populated file behind, matching AtomicFiles.java.
 * DuckDB session files and profiles.json both rely on this: a crashed upload must
 * not surface as a readable-but-corrupt session.
 */
export const AtomicFiles = {
  async writeString(target: string, content: string): Promise<void> {
    await withTempWrite(target, (temp) => fs.promises.writeFile(temp, content, 'utf8'));
  },

  async writeBuffer(target: string, content: Uint8Array): Promise<void> {
    await withTempWrite(target, (temp) => fs.promises.writeFile(temp, content));
  },

  async copy(source: string, target: string): Promise<void> {
    await withTempWrite(target, (temp) => fs.promises.copyFile(source, temp));
  },

  async copyStream(source: Readable, target: string): Promise<void> {
    await withTempWrite(target, async (temp) => {
      await pipeline(source, fs.createWriteStream(temp));
    });
  },

  async move(source: string, target: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await moveIntoPlace(source, target);
  },

  async deleteRecursively(target: string): Promise<void> {
    await fs.promises.rm(target, { recursive: true, force: true });
  },
};

export function exists(target: string): boolean {
  return fs.existsSync(target);
}

export function isRegularFile(target: string): boolean {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

export function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}
