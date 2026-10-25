import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Env } from '../../config/env.js';
import type { Logger } from '../../lib/log.js';

/**
 * Resolves all application data paths. The layout mirrors the Python and Java
 * backends so existing user data is picked up without migration.
 */
export class AppPaths {
  readonly appHome: string;
  readonly dataRoot: string;
  readonly gameTelemetryDir: string | null;
  readonly frontendDir: string;
  readonly steeringWheelDir: string;

  constructor(
    private readonly env: Env,
    private readonly logger: Logger,
  ) {
    this.appHome = env.appHome;
    this.dataRoot = this.resolveDataRoot();
    this.gameTelemetryDir = this.resolveTelemetryDir(env.telemetryDir);
    this.frontendDir = this.resolveFrontendDir(env.frontendDir);
    this.steeringWheelDir = this.resolveSteeringWheelDir(env.steeringWheelDir);
  }

  init(): void {
    fs.mkdirSync(this.dataRoot, { recursive: true });
    this.ensureProfileDirs('guest');
    this.logger.info(
      {
        appHome: this.appHome,
        dataRoot: this.dataRoot,
        gameTelemetryDir: this.gameTelemetryDir ?? '<disabled>',
        frontendDir: this.frontendDir,
        steeringWheelDir: this.steeringWheelDir,
      },
      'Paths resolved',
    );
  }

  private resolveDataRoot(): string {
    const configured = this.env.dataDir.trim();
    if (configured !== '') return path.resolve(configured);

    const localAppData = process.env.LOCALAPPDATA;
    const base =
      localAppData !== undefined && localAppData.trim() !== '' ? localAppData : os.homedir();
    const folder = this.env.devMode ? 'LMU_Telemetry_Lab_Dev' : 'LMU_Telemetry_Lab';
    return path.resolve(base, folder);
  }

  private resolveAgainstHome(raw: string | undefined): string {
    if (raw === undefined || raw.trim() === '') return this.appHome;
    return path.resolve(this.appHome, raw.trim());
  }

  private isDirectory(target: string): boolean {
    try {
      return fs.statSync(target).isDirectory();
    } catch {
      return false;
    }
  }

  private resolveTelemetryDir(configured: string): string | null {
    const trimmed = configured.trim();
    if (trimmed === '') return null;
    const dir = path.resolve(trimmed);
    if (!this.isDirectory(dir)) {
      this.logger.warn(
        { dir },
        'Configured telemetry dir does not exist, direct game reads disabled',
      );
      return null;
    }
    return dir;
  }

  private resolveFrontendDir(configured: string): string {
    const direct = this.resolveAgainstHome(configured);
    if (this.isDirectory(direct)) return direct;
    const appImageLayout = path.resolve(this.appHome, 'frontend/dist');
    if (this.isDirectory(appImageLayout)) return appImageLayout;
    return direct;
  }

  private resolveSteeringWheelDir(configured: string): string {
    const direct = this.resolveAgainstHome(configured);
    if (this.isDirectory(direct)) return direct;
    const publicDir = path.resolve(this.appHome, 'frontend/public/steering wheel');
    if (this.isDirectory(publicDir)) return publicDir;
    const distDir = path.resolve(this.appHome, 'frontend/dist/steering wheel');
    if (this.isDirectory(distDir)) return distDir;
    return direct;
  }

  profilesFile(): string {
    return path.join(this.dataRoot, 'profiles.json');
  }

  profileRoot(profileId: string): string {
    return path.resolve(this.dataRoot, 'Data', profileId);
  }

  profileDataDir(profileId: string): string {
    return path.resolve(this.profileRoot(profileId), 'DuckDB_data');
  }

  profileCacheDir(profileId: string): string {
    return path.resolve(this.profileRoot(profileId), 'cache');
  }

  profileAvatarDir(profileId: string): string {
    return path.resolve(this.profileRoot(profileId), 'avatars');
  }

  legacyDataDir(): string {
    return path.resolve(this.appHome, 'DuckDB_data');
  }

  ensureProfileDirs(profileId: string): void {
    for (const dir of [
      this.profileDataDir(profileId),
      this.profileCacheDir(profileId),
      this.profileAvatarDir(profileId),
    ]) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (error) {
        throw new Error(`Failed to create profile directories for ${profileId}`, { cause: error });
      }
    }
  }

  version(): string {
    return this.env.version;
  }

  devMode(): boolean {
    return this.env.devMode;
  }

  platform(): string {
    return os.platform().toLowerCase();
  }
}
