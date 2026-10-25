import fs from 'node:fs/promises';
import path from 'node:path';
import { ApiException } from '../../api/error.js';
import type { Profile } from '../../domain/types.js';
import type { Logger } from '../../lib/log.js';
import type { AppPaths } from './app-paths.js';
import { AtomicFiles, isDirectory, isRegularFile } from './atomic-files.js';
import { PathSafety } from './path-safety.js';

/**
 * Java's `Profile.avatar_url` is a nullable record component serialised with NON_NULL,
 * so it is simply absent from profiles.json. `undefined` is the TypeScript equivalent.
 */
type StoredProfile = Omit<Profile, 'avatar_url'> & { avatar_url?: string | undefined };

function asProfile(profile: StoredProfile): Profile {
  return profile as Profile;
}

function withSessionCount(profile: StoredProfile, count: number): StoredProfile {
  return { ...profile, session_count: count };
}

function withoutSessionCount(profile: StoredProfile): StoredProfile {
  const { session_count: _sessionCount, ...rest } = profile;
  return rest;
}

function withName(profile: StoredProfile, newName: string): StoredProfile {
  return { ...profile, name: newName };
}

function withAvatar(profile: StoredProfile, avatarUrl: string | null | undefined): StoredProfile {
  return { ...profile, avatar_url: avatarUrl ?? undefined };
}

function withDefault(profile: StoredProfile, value: boolean): StoredProfile {
  return { ...profile, is_default: value };
}

/** Java formats with DateTimeFormatter.ISO_LOCAL_DATE_TIME: local time, no zone suffix. */
function localDateTime(): string {
  const now = new Date();
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(
    now.getHours(),
  )}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
  return now.getMilliseconds() === 0 ? stamp : `${stamp}.${pad(now.getMilliseconds(), 3)}`;
}

function newProfile(name: string, id: string, isDefault: boolean, avatarUrl: string | null): StoredProfile {
  const timestamp = localDateTime();
  return {
    id,
    name,
    created_at: timestamp,
    last_used: timestamp,
    is_default: isDefault,
    avatar_url: avatarUrl ?? undefined,
  };
}

function decodeProfile(value: unknown): StoredProfile {
  const raw = (value ?? {}) as Record<string, unknown>;
  const profile: StoredProfile = {
    id: typeof raw.id === 'string' ? raw.id : '',
    name: typeof raw.name === 'string' ? raw.name : '',
    created_at: typeof raw.created_at === 'string' ? raw.created_at : '',
    last_used: typeof raw.last_used === 'string' ? raw.last_used : '',
    is_default: raw.is_default === true,
  };
  if (typeof raw.avatar_url === 'string') profile.avatar_url = raw.avatar_url;
  if (typeof raw.session_count === 'number') profile.session_count = raw.session_count;
  return profile;
}

function isDuckDb(fileName: string): boolean {
  return PathSafety.isDuckDb(fileName);
}

export class ProfileRepository {
  private readonly paths: AppPaths;
  private readonly logger: Logger;
  // Java guards the read-modify-write cycles with a ReentrantReadWriteLock; every section
  // here awaits I/O, so all of them collapse onto one serial queue.
  private queue: Promise<unknown> = Promise.resolve();

  constructor(paths: AppPaths, logger: Logger) {
    this.paths = paths;
    this.logger = logger;
  }

  async list(): Promise<Profile[]> {
    return this.exclusive(async () => {
      const storage = await this.readLocked();
      const result: Profile[] = [];
      for (const profile of storage) {
        result.push(asProfile(withSessionCount(profile, await this.countSessions(profile.id))));
      }
      return result;
    });
  }

  async find(profileId: string): Promise<Profile | undefined> {
    const safeId = safeProfileId(profileId);
    return this.exclusive(async () => {
      const profiles = await this.readLocked();
      const found = profiles.find((profile) => profile.id === safeId);
      return found === undefined ? undefined : asProfile(found);
    });
  }

  async ensureGuest(): Promise<Profile> {
    return this.exclusive(async () => {
      const profiles = await this.readLocked();
      if (profiles.length > 0) {
        return asProfile(profiles[0]);
      }
      const guest = newProfile('Guest', 'guest', true, null);
      this.paths.ensureProfileDirs(guest.id);
      profiles.push(guest);
      await this.saveLocked(profiles);
      this.logger.info('Created default Guest profile');
      return asProfile(withSessionCount(guest, 0));
    });
  }

  async create(name: string | null, isDefault: boolean, avatarUrl: string | null): Promise<Profile> {
    if (name === null || name.trim() === '') {
      throw new ApiException(400, 'Profile name is required');
    }
    const trimmed = name.trim();
    return this.exclusive(async () => {
      const profiles = await this.readLocked();
      for (const existing of profiles) {
        if (existing.name.toLowerCase() === trimmed.toLowerCase()) {
          return asProfile(withSessionCount(existing, await this.countSessions(existing.id)));
        }
      }
      const id = uniqueId(profiles, trimmed);
      const created = newProfile(trimmed, id, isDefault, avatarUrl);
      this.paths.ensureProfileDirs(id);
      profiles.push(created);
      await this.saveLocked(profiles);
      this.logger.info({ name: trimmed, id }, `Created profile: ${trimmed} (id=${id})`);
      return asProfile(withSessionCount(created, 0));
    });
  }

  async updateName(profileId: string, newName: string | null): Promise<boolean> {
    if (newName === null || newName.trim() === '') {
      throw new ApiException(400, 'Profile name is required');
    }
    const safeId = safeProfileId(profileId);
    return this.exclusive(async () => {
      const profiles = await this.readLocked();
      for (let index = 0; index < profiles.length; index++) {
        const profile = profiles[index];
        if (profile.id === safeId) {
          profiles[index] = withName(profile, newName.trim());
          await this.saveLocked(profiles);
          return true;
        }
      }
      return false;
    });
  }

  async updateAvatar(profileId: string, avatarUrl: string | null): Promise<boolean> {
    const safeId = safeProfileId(profileId);
    return this.exclusive(async () => {
      const profiles = await this.readLocked();
      for (let index = 0; index < profiles.length; index++) {
        const profile = profiles[index];
        if (profile.id === safeId) {
          profiles[index] = withAvatar(profile, avatarUrl);
          await this.saveLocked(profiles);
          return true;
        }
      }
      return false;
    });
  }

  async reorder(profileIds: string[] | null | undefined): Promise<Profile[]> {
    return this.exclusive(async () => {
      const profiles = await this.readLocked();
      const byId = new Map<string, StoredProfile>();
      for (const profile of profiles) {
        byId.set(profile.id, profile);
      }
      const reordered: StoredProfile[] = [];
      if (profileIds !== null && profileIds !== undefined) {
        for (const rawId of profileIds) {
          if (rawId === null || rawId === undefined) {
            continue;
          }
          const profile = byId.get(rawId);
          byId.delete(rawId);
          if (profile !== undefined) {
            reordered.push(withDefault(profile, reordered.length === 0));
          }
        }
      }
      let firstRemaining = reordered.length === 0;
      for (const profile of byId.values()) {
        reordered.push(withDefault(profile, firstRemaining));
        firstRemaining = false;
      }
      await this.saveLocked(reordered);
      const result: Profile[] = [];
      for (const profile of reordered) {
        result.push(asProfile(withSessionCount(profile, await this.countSessions(profile.id))));
      }
      return result;
    });
  }

  async delete(profileId: string): Promise<void> {
    const safeId = safeProfileId(profileId);
    if (safeId === 'guest') {
      return;
    }
    return this.exclusive(async () => {
      const profiles = await this.readLocked();
      const remaining: StoredProfile[] = [];
      let found = false;
      for (const profile of profiles) {
        if (profile.id === safeId) {
          found = true;
        } else {
          remaining.push(profile);
        }
      }
      if (!found) {
        return;
      }
      try {
        await AtomicFiles.deleteRecursively(this.paths.profileRoot(safeId));
      } catch (error) {
        throw new ApiException(500, 'Failed to delete profile files', { cause: error });
      }
      await this.saveLocked(remaining);
      this.logger.info({ profileId: safeId }, `Deleted profile: ${safeId}`);
    });
  }

  /**
   * The pre-profile builds kept every session in `<appHome>/DuckDB_data`; those files are
   * handed to the Guest profile so nothing disappears on upgrade. Presence of any `.duckdb`
   * file in the guest directory already marks the migration as done, which keeps it idempotent.
   */
  async migrateLegacyData(): Promise<void> {
    const legacy = this.paths.legacyDataDir();
    if (!isDirectory(legacy)) {
      return;
    }
    const guestData = this.paths.profileDataDir('guest');
    try {
      this.paths.ensureProfileDirs('guest');
      const existing = await duckDbFilesIn(guestData);
      if (existing.length > 0) {
        return;
      }
      for (const file of await duckDbFilesIn(legacy)) {
        await AtomicFiles.copy(file, path.join(guestData, path.basename(file)));
        this.logger.info({ file }, `Migrated legacy session: ${path.basename(file)}`);
      }
    } catch (error) {
      this.logger.warn({ err: error }, 'Legacy data migration failed');
    }
  }

  private exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.queue.then(task, task);
    this.queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async countSessions(profileId: string): Promise<number> {
    const dir = this.paths.profileDataDir(profileId);
    if (!isDirectory(dir)) {
      return 0;
    }
    try {
      return (await duckDbFilesIn(dir)).length;
    } catch {
      return 0;
    }
  }

  private async readLocked(): Promise<StoredProfile[]> {
    const file = this.paths.profilesFile();
    if (!isRegularFile(file)) {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parsed.map(decodeProfile);
    } catch (error) {
      this.logger.error({ err: error }, 'Failed to read profiles.json; returning empty list');
      return [];
    }
  }

  private async saveLocked(profiles: StoredProfile[]): Promise<void> {
    const storage = profiles.map(withoutSessionCount);
    try {
      const json = JSON.stringify(storage, null, 2);
      await AtomicFiles.writeString(this.paths.profilesFile(), json);
    } catch (error) {
      throw new ApiException(500, 'Failed to save profiles.json', { cause: error });
    }
  }
}

async function duckDbFilesIn(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isFile() && isDuckDb(entry.name)) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

function uniqueId(profiles: StoredProfile[], name: string): string {
  let base = name.toLowerCase().replaceAll(' ', '_');
  base = base.replaceAll(/[\\/:*?"<>|]/g, '_');
  if (base.trim() === '') {
    base = `user_${profiles.length}`;
  }
  let candidate = base;
  let suffix = 2;
  while (profiles.some((profile) => profile.id === candidate)) {
    candidate = `${base}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function safeProfileId(profileId: string): string {
  const safe = PathSafety.safeFileName(profileId);
  if (safe === '.' || safe === '..' || safe.includes('/') || safe.includes('\\')) {
    throw new ApiException(400, 'Invalid profile id');
  }
  return safe;
}
