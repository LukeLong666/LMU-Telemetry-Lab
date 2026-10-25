import path from 'node:path';
import type { Readable } from 'node:stream';
import { ApiException } from '../api/error.js';
import type { Profile } from '../domain/types.js';
import type { Logger } from '../lib/log.js';
import type { AppPaths } from '../infra/fs/app-paths.js';
import { AtomicFiles } from '../infra/fs/atomic-files.js';
import type { ProfileRepository } from '../infra/fs/profile-repository.js';
import { PathSafety } from '../infra/fs/path-safety.js';

/** Java: `MAX_AVATAR_BYTES = 10L * 1024 * 1024`. */
const MAX_AVATAR_BYTES = 10 * 1024 * 1024;
/** Java: `ALLOWED_AVATAR_EXTENSIONS` — the whitelist is extension based, the MIME type is never read. */
const ALLOWED_AVATAR_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
/** Java: `"/api/v1/profile-data/Data/" + profile.id() + "/avatars/" + filename`, served by WebConfig. */
const AVATAR_URL_PREFIX = '/api/v1/profile-data/Data/';

/**
 * The slice of Spring's MultipartFile the avatar upload needs. The route hands over the
 * multipart part as-is: `filename` is the client-supplied name, `stream` the part body,
 * `size` the declared byte count (Java's `file.getSize()`) when the route already knows it.
 * The service owns the stream: it is consumed on success and destroyed on every rejection.
 */
export interface AvatarUpload {
  filename: string | null | undefined;
  stream: Readable;
  /** Part MIME type, accepted for completeness. Java never inspects it, so neither do we. */
  contentType?: string | null;
  size?: number | null;
}

/**
 * Profile CRUD plus avatar storage. Port of ProfileService.java; the per-profile
 * `session_count` is filled by ProfileRepository.list(), exactly as in Java.
 */
export class ProfileService {
  private readonly repository: ProfileRepository;
  private readonly paths: AppPaths;
  private readonly logger: Logger;

  constructor(repository: ProfileRepository, paths: AppPaths, logger: Logger) {
    this.repository = repository;
    this.paths = paths;
    this.logger = logger;
  }

  /** Java's `@PostConstruct init()`. Call it once from the composition root, never at import time. */
  async init(): Promise<void> {
    await this.repository.ensureGuest();
    await this.repository.migrateLegacyData();
  }

  /** GET /profiles — self-heals an empty store the same way Java does. */
  async list(): Promise<Profile[]> {
    let profiles = await this.repository.list();
    if (profiles.length === 0) {
      await this.repository.ensureGuest();
      profiles = await this.repository.list();
    }
    return profiles;
  }

  async create(name: string | null | undefined): Promise<Profile> {
    return this.repository.create(name ?? null, false, null);
  }

  async reorder(profileIds: string[] | null | undefined): Promise<Profile[]> {
    return this.repository.reorder(profileIds);
  }

  async delete(profileId: string): Promise<void> {
    await this.repository.delete(profileId);
  }

  async update(profileId: string, name: string | null | undefined): Promise<void> {
    if (!(await this.repository.updateName(profileId, name ?? null))) {
      throw new ApiException(404, 'Profile not found');
    }
  }

  /** POST /profiles/{id}/avatar — stores the image and returns the `avatar_url` to serve it. */
  async uploadAvatar(profileId: string, file: AvatarUpload | null | undefined): Promise<string> {
    const profile = await this.repository.find(profileId);
    if (profile === undefined) {
      discard(file);
      throw new ApiException(404, 'Profile not found');
    }
    if (file === null || file === undefined) {
      throw new ApiException(400, 'Avatar file is required');
    }

    const declared = typeof file.size === 'number' ? file.size : null;
    if (declared !== null && declared === 0) {
      discard(file);
      throw new ApiException(400, 'Avatar file is required');
    }
    if (declared !== null && declared > MAX_AVATAR_BYTES) {
      discard(file);
      throw new ApiException(413, 'Avatar file too large');
    }

    // readCapped owns the stream: it consumes it fully and destroys it on every exit path.
    const content = await readCapped(file.stream, MAX_AVATAR_BYTES);
    if (content.length === 0) {
      throw new ApiException(400, 'Avatar file is required');
    }

    // Java: `safeFileName(original == null ? "avatar" : original)` — a blank name is rejected
    // by safeFileName itself with "File name is required", which we keep as-is.
    const safeName = PathSafety.safeFileName(
      file.filename === null || file.filename === undefined ? 'avatar' : file.filename,
    );
    const extension = extensionOf(safeName);
    if (!ALLOWED_AVATAR_EXTENSIONS.has(extension)) {
      throw new ApiException(400, 'Unsupported avatar file type');
    }

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const filename = `avatar_${timestamp}${extension}`;
    const dir = this.paths.profileAvatarDir(profile.id);
    const target = resolveAvatarPath(dir, filename);

    try {
      await AtomicFiles.writeBuffer(target, content);
    } catch (error) {
      throw new ApiException(500, 'Failed to save avatar', { cause: error });
    }

    const avatarUrl = `${AVATAR_URL_PREFIX}${profile.id}/avatars/${filename}`;
    if (!(await this.repository.updateAvatar(profile.id, avatarUrl))) {
      throw new ApiException(404, 'Profile not found');
    }
    this.logger.info(
      { profileId: profile.id, filename },
      `Updated avatar for profile ${profile.id}: ${filename}`,
    );
    return avatarUrl;
  }
}

/** Java: `filename.substring(lastIndexOf('.')).toLowerCase(Locale.ROOT)`; '' when there is no dot. */
function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot).toLowerCase();
}

/** Java normalises and re-checks the target against the avatar dir before writing. */
function resolveAvatarPath(dir: string, filename: string): string {
  const root = path.resolve(dir);
  const target = path.resolve(root, filename);
  const relative = path.relative(root, target);
  if (relative === '' || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ApiException(400, 'Invalid avatar path');
  }
  return target;
}

async function readCapped(source: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const raw of source) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
      total += chunk.length;
      if (total > maxBytes) {
        throw new ApiException(413, 'Avatar file too large');
      }
      chunks.push(chunk);
    }
  } finally {
    discard({ stream: source });
  }
  return Buffer.concat(chunks, total);
}

/** An unread multipart part would keep the request alive; Java discards it for us. */
function discard(file: { stream?: Readable } | null | undefined): void {
  const stream = file?.stream;
  if (stream !== undefined && !stream.destroyed) {
    stream.destroy();
  }
}
