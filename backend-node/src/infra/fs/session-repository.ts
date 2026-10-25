import fs from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { ApiException } from '../../api/error.js';
import type { Logger } from '../../lib/log.js';
import type { AppPaths } from './app-paths.js';
import { AtomicFiles, exists, isDirectory, isRegularFile } from './atomic-files.js';
import { PathSafety } from './path-safety.js';

const DISCORD_PREFIX = 'discord__';

/** Attachment fields Java reads via `Map.get("url")`; only the URL matters for a download. */
export interface DiscordAttachmentRef {
  url?: string | null;
  filename?: string | null;
  size?: number | null;
}

/** The `LinkedHashMap` with `telemetry` / `setup` keys returned by getThreadAttachments. */
export interface DiscordAttachmentMap {
  telemetry: DiscordAttachmentRef | null;
  setup?: DiscordAttachmentRef | null;
}

/**
 * The two Discord capabilities `discord__<threadId>` session ids need. Java injects the
 * concrete DiscordClient; declaring the port here keeps infra/fs free of discord.js.
 */
export interface DiscordSessionGateway {
  getThreadAttachments(threadId: string): Promise<DiscordAttachmentMap | null>;
  downloadFile(url: string, destination: string): Promise<void>;
}

/** The slice of Spring's MultipartFile the repository uses; the route adapts Fastify's file part. */
export interface IncomingFile {
  filename: string | null;
  stream: Readable;
  /** Known byte count, used for the empty check and as the size fallback (Java: file.getSize()). */
  size?: number | null;
}

export interface UploadedSession {
  id: string;
  size: number;
}

interface SessionFile {
  file: string;
  modified: number;
}

export class SessionRepository {
  private readonly paths: AppPaths;
  private readonly discordClient: DiscordSessionGateway;
  private readonly logger: Logger;

  constructor(paths: AppPaths, discordClient: DiscordSessionGateway, logger: Logger) {
    this.paths = paths;
    this.discordClient = discordClient;
    this.logger = logger;
  }

  async listFiles(profileId: string): Promise<string[]> {
    const byName = new Map<string, string>();
    for (const file of await this.duckDbFilesIn(this.paths.profileDataDir(profileId))) {
      byName.set(path.basename(file), file);
    }
    const gameDir = this.paths.gameTelemetryDir;
    if (gameDir !== null) {
      for (const file of await this.duckDbFilesIn(gameDir)) {
        if (!byName.has(path.basename(file))) {
          byName.set(path.basename(file), file);
        }
      }
    }
    const entries: SessionFile[] = [];
    for (const file of byName.values()) {
      entries.push({ file, modified: await lastModifiedMillis(file) });
    }
    // Newest first; Array.prototype.sort is stable, so equal mtimes keep the insertion order.
    entries.sort((a, b) => b.modified - a.modified);
    return entries.map((entry) => entry.file);
  }

  async resolve(profileId: string, sessionId: string | null): Promise<string> {
    if (sessionId !== null && sessionId.startsWith(DISCORD_PREFIX)) {
      return this.resolveDiscordSession(sessionId);
    }
    const dir = this.paths.profileDataDir(profileId);
    const file = PathSafety.resolveUnder(dir, sessionId ?? '');
    if (!PathSafety.isDuckDb(path.basename(file))) {
      throw new ApiException(400, 'Only .duckdb files are supported');
    }
    if (isRegularFile(file)) {
      return file;
    }
    const fromGame = await this.resolveInGameTelemetry(sessionId ?? '');
    if (fromGame !== null) {
      return fromGame;
    }
    throw new ApiException(404, 'Session not found');
  }

  async upload(profileId: string, file: IncomingFile | null | undefined): Promise<UploadedSession> {
    if (file === null || file === undefined || file.size === 0) {
      throw new ApiException(400, 'File is required');
    }
    const original = file.filename === null || file.filename === undefined ? 'session.duckdb' : file.filename;
    const fileName = PathSafety.safeFileName(original);
    if (!PathSafety.isDuckDb(fileName)) {
      throw new ApiException(400, 'Only .duckdb files are allowed');
    }
    const target = PathSafety.resolveUnder(this.paths.profileDataDir(profileId), fileName);
    try {
      await AtomicFiles.copyStream(file.stream, target);
    } catch (error) {
      throw new ApiException(500, `Upload failed: ${errorMessage(error)}`, { cause: error });
    }
    try {
      return { id: fileName, size: (await fs.stat(target)).size };
    } catch {
      return { id: fileName, size: file.size ?? 0 };
    }
  }

  async importPaths(profileId: string, sourcePaths: string[] | null | undefined): Promise<string[]> {
    if (sourcePaths === null || sourcePaths === undefined || sourcePaths.length === 0) {
      throw new ApiException(400, 'No files selected');
    }
    const dir = this.paths.profileDataDir(profileId);
    const sources: string[] = [];
    for (const raw of sourcePaths) {
      if (raw === null || raw.trim() === '') {
        throw new ApiException(400, 'Invalid source path');
      }
      if (!path.isAbsolute(raw)) {
        throw new ApiException(400, `Source path must be absolute: ${raw}`);
      }
      const source = path.resolve(raw);
      if (!isRegularFile(source)) {
        throw new ApiException(400, `Source file not found: ${raw}`);
      }
      const fileName = PathSafety.safeFileName(path.basename(source));
      if (!PathSafety.isDuckDb(fileName)) {
        throw new ApiException(400, `Only .duckdb files are allowed: ${raw}`);
      }
      sources.push(source);
    }

    const imported: string[] = [];
    for (const source of sources) {
      const fileName = PathSafety.safeFileName(path.basename(source));
      const target = PathSafety.resolveUnder(dir, fileName);
      try {
        await AtomicFiles.copy(source, target);
        imported.push(fileName);
      } catch (error) {
        throw new ApiException(
          500,
          `Failed to import ${path.basename(source)}: ${errorMessage(error)}`,
          { cause: error },
        );
      }
    }
    this.logger.info({ profileId, count: imported.length }, `Imported ${imported.length} file(s) into profile ${profileId}`);
    return imported;
  }

  async rename(profileId: string, sessionId: string | null, newName: string | null): Promise<string> {
    const dir = this.paths.profileDataDir(profileId);
    const oldPath = await this.resolveWritable(profileId, sessionId);
    const trimmed = newName === null ? '' : newName.trim();
    if (trimmed === '') {
      throw new ApiException(400, 'New name is required');
    }
    let targetName = PathSafety.isDuckDb(trimmed) ? trimmed : `${trimmed}.duckdb`;
    targetName = PathSafety.safeFileName(targetName);
    if (!PathSafety.isDuckDb(targetName)) {
      throw new ApiException(400, 'Invalid file name');
    }
    const newPath = PathSafety.resolveUnder(dir, targetName);
    if (exists(newPath)) {
      throw new ApiException(400, 'File with new name already exists');
    }
    try {
      await fs.rename(oldPath, newPath);
      await this.clearCache(profileId, sessionId ?? '');
      this.logger.info(
        { sessionId, targetName, profileId },
        `Renamed session ${sessionId} -> ${targetName} (profile=${profileId})`,
      );
      return targetName;
    } catch (error) {
      throw new ApiException(500, `Rename failed: ${errorMessage(error)}`, { cause: error });
    }
  }

  async delete(profileId: string, sessionId: string | null): Promise<void> {
    const file = await this.resolveWritable(profileId, sessionId);
    try {
      await fs.rm(file, { force: true });
      await this.clearCache(profileId, sessionId ?? '');
      this.logger.info({ sessionId, profileId }, `Deleted session ${sessionId} (profile=${profileId})`);
    } catch (error) {
      throw new ApiException(500, `Delete failed: ${errorMessage(error)}`, { cause: error });
    }
  }

  async clearCache(profileId: string, sessionId: string): Promise<void> {
    const cacheDir = this.paths.profileCacheDir(profileId);
    if (!isDirectory(cacheDir)) {
      return;
    }
    try {
      const entries = await fs.readdir(cacheDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.startsWith(sessionId)) {
          await fs.rm(path.join(cacheDir, entry.name), { force: true });
        }
      }
    } catch (error) {
      this.logger.warn(
        { sessionId, err: error },
        `Failed to clear cache for ${sessionId}: ${errorMessage(error)}`,
      );
    }
  }

  private async resolveInGameTelemetry(sessionId: string): Promise<string | null> {
    const gameDir = this.paths.gameTelemetryDir;
    if (gameDir === null) {
      return null;
    }
    const candidate = PathSafety.resolveUnder(gameDir, sessionId);
    return isRegularFile(candidate) ? candidate : null;
  }

  private async resolveWritable(profileId: string, sessionId: string | null): Promise<string> {
    const dir = this.paths.profileDataDir(profileId);
    const file = PathSafety.resolveUnder(dir, sessionId ?? '');
    if (!PathSafety.isDuckDb(path.basename(file))) {
      throw new ApiException(400, 'Only .duckdb files are supported');
    }
    if (!isRegularFile(file)) {
      throw new ApiException(400, 'Sessions read straight from the game telemetry folder are read-only');
    }
    return file;
  }

  private async resolveDiscordSession(sessionId: string): Promise<string> {
    const threadId = sessionId.slice(DISCORD_PREFIX.length);
    if (!/^\d+$/.test(threadId)) {
      throw new ApiException(400, 'Invalid Discord thread id');
    }
    const cacheDir = path.join(this.paths.dataRoot, 'cache', 'discord_temp');
    const cached = path.join(cacheDir, `${threadId}.duckdb`);
    if (isRegularFile(cached)) {
      return cached;
    }
    try {
      await fs.mkdir(cacheDir, { recursive: true });
      const attachments = await this.discordClient.getThreadAttachments(threadId);
      const telemetry = attachments === null || attachments === undefined ? null : attachments.telemetry;
      if (telemetry === null || telemetry === undefined) {
        throw new ApiException(404, 'Discord telemetry attachment not found.');
      }
      await this.discordClient.downloadFile(String(telemetry.url ?? null), cached);
      return cached;
    } catch (error) {
      if (error instanceof ApiException) {
        throw error;
      }
      await fs.rm(cached, { force: true }).catch(() => undefined);
      throw new ApiException(500, `Failed to download Discord session: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }

  private async duckDbFilesIn(dir: string): Promise<string[]> {
    if (!isDirectory(dir)) {
      return [];
    }
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        if (entry.isFile() && PathSafety.isDuckDb(entry.name)) {
          files.push(path.join(dir, entry.name));
        }
      }
      return files;
    } catch (error) {
      throw new ApiException(500, 'Failed to list sessions', { cause: error });
    }
  }
}

async function lastModifiedMillis(target: string): Promise<number> {
  try {
    return (await fs.stat(target)).mtimeMs;
  } catch {
    return 0;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
