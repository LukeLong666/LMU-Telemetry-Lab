import { spawn } from 'node:child_process';
import path from 'node:path';
import type { OpenPathRequest } from '../api/dto.js';
import { ApiException } from '../api/error.js';
import type { Logger } from '../lib/log.js';
import { exists } from '../infra/fs/atomic-files.js';
import type { AppPaths } from '../infra/fs/app-paths.js';
import type { SessionRepository } from '../infra/fs/session-repository.js';
import type { SteeringWheelScan, SteeringWheelScanner } from '../infra/system/steering-wheel-scanner.js';
import type { FilePicker } from '../infra/system/file-picker.js';

/**
 * The host capability behind POST /system/open-path: launch the platform file manager.
 * Java calls `ProcessBuilder(...).start()` and never waits for the process; here the
 * command and its arguments stay separated (`args` is always an array — never a shell
 * string), because the argument is a user-supplied path and would otherwise be injectable.
 * Throwing synchronously maps to Java's `IOException` from `start()`.
 */
export type SpawnFileManager = (command: string, args: string[]) => void;

export interface SystemServiceOptions {
  /** Test seam; defaults to a detached `child_process.spawn`. */
  spawn?: SpawnFileManager;
}

export interface ValidatePathResponse {
  exists: boolean;
}

export interface OpenPathResponse {
  status: 'success' | 'partial';
  message: string;
}

export interface ImportPathsResponse {
  status: 'success';
  id: string;
  ids: string[];
  message: string;
}

export interface PickCancelledResponse {
  status: 'cancelled';
}

export type PickAndUploadResponse = PickCancelledResponse | ImportPathsResponse;

/** Java uses `System.getProperty("os.name")` with `contains("win")`/`contains("mac")`. */
export function openPathCommand(platform: string, target: string): [string, string[]] {
  const normalized = platform.toLowerCase();
  // The macOS branch is checked first: `darwin` happens to contain the letters "win".
  if (normalized === 'darwin' || normalized.includes('mac')) {
    return ['open', [target]];
  }
  if (normalized === 'win32' || normalized.includes('windows')) {
    return ['explorer.exe', [target]];
  }
  return ['xdg-open', [target]];
}

/**
 * Host-facing capabilities: path validation, revealing a path in the file manager,
 * importing picked paths, and the steering wheel catalogue. Port of SystemService.java.
 */
export class SystemService {
  private readonly sessions: SessionRepository;
  private readonly filePicker: FilePicker;
  // Java names the field and the accessor `steeringWheels`; JS has one namespace, so the
  // field is renamed and the public method keeps the Java name.
  private readonly wheelScanner: SteeringWheelScanner;
  private readonly paths: AppPaths;
  private readonly logger: Logger;
  private readonly spawnFn: SpawnFileManager;

  constructor(
    sessions: SessionRepository,
    filePicker: FilePicker,
    steeringWheels: SteeringWheelScanner,
    paths: AppPaths,
    logger: Logger,
    options: SystemServiceOptions = {},
  ) {
    this.sessions = sessions;
    this.filePicker = filePicker;
    this.wheelScanner = steeringWheels;
    this.paths = paths;
    this.logger = logger;
    this.spawnFn = options.spawn ?? defaultSpawnFileManager(logger);
  }

  /** GET /system/validate-path — the only thing the client learns about an arbitrary path. */
  async validatePath(rawPath: string | null | undefined): Promise<ValidatePathResponse> {
    let present = false;
    if (rawPath !== null && rawPath !== undefined && rawPath.trim() !== '') {
      present = exists(path.normalize(rawPath));
    }
    return { exists: present };
  }

  /** POST /system/open-path — reveal the path, or its parent when the path itself is gone. */
  async openPath(rawPath: string | null | undefined): Promise<OpenPathResponse> {
    if (rawPath === null || rawPath === undefined || rawPath.trim() === '') {
      throw new ApiException(400, 'Path is required');
    }
    const target = path.normalize(rawPath);
    if (exists(target)) {
      this.openInFileManager(target);
      return { status: 'success', message: `Opening ${target}` };
    }
    const parent = parentOf(target);
    if (parent !== null && exists(parent)) {
      this.openInFileManager(parent);
      return { status: 'partial', message: `Path not found, opening parent: ${parent}` };
    }
    throw new ApiException(404, 'Path not found');
  }

  /** POST /system/import-paths — copy already-known absolute paths into the profile. */
  async importPaths(
    sourcePaths: string[] | null | undefined,
    profileId: string | null | undefined,
  ): Promise<ImportPathsResponse> {
    const imported = await this.sessions.importPaths(normalizeProfile(profileId), sourcePaths);
    return {
      status: 'success',
      id: imported[imported.length - 1],
      ids: imported,
      message: `Imported ${imported.length} file(s)`,
    };
  }

  /**
   * POST /system/pick-and-upload. FilePicker owns the headless/bridge errors: without an
   * injected native dialog it throws ApiException(400, "Native file picker is unavailable in
   * headless mode"), which propagates untouched (Java reached the same text through
   * IllegalStateException -> 500; plan section 6.1 pins the status to 400 for Node).
   */
  async pickAndUpload(
    request: OpenPathRequest | null | undefined,
    profileId: string | null | undefined,
  ): Promise<PickAndUploadResponse> {
    const selected = await this.filePicker.pick(request);
    if (selected.length === 0) {
      return { status: 'cancelled' };
    }
    return this.importPaths(selected, profileId);
  }

  /** GET /steering-wheels */
  async steeringWheels(): Promise<SteeringWheelScan> {
    return this.wheelScanner.scan();
  }

  private openInFileManager(target: string): void {
    const [command, args] = openPathCommand(this.paths.platform(), target);
    try {
      this.spawnFn(command, args);
    } catch (error) {
      this.logger.error({ err: error, path: target }, `Failed to open path ${target}`);
      const message = error instanceof Error ? error.message : String(error);
      throw new ApiException(500, `Failed to open path: ${message}`, { cause: error });
    }
  }
}

/** Java's `Path.getParent()`: null for a single-segment path, which `path.dirname` reports as '.'. */
function parentOf(target: string): string | null {
  const parent = path.dirname(target);
  if (parent === target || parent === '' || parent === '.') {
    return null;
  }
  return parent;
}

function normalizeProfile(profileId: string | null | undefined): string {
  return profileId === null || profileId === undefined || profileId.trim() === '' ? 'guest' : profileId;
}

/**
 * Detached fire-and-forget launch: `explorer.exe` never exits on its own, so the child is
 * unref'd instead of awaited. A late spawn failure (missing binary) only surfaces as an
 * async 'error' event — logged and swallowed, since the reply is already decided by then.
 */
function defaultSpawnFileManager(logger: Logger): SpawnFileManager {
  return (command, args) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.once('error', (error) => {
      logger.error({ err: error, command }, `Failed to open path via ${command}`);
    });
    child.unref();
  };
}
