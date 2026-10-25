/**
 * Request/response payload shapes, 1:1 with backend-java/src/main/java/com/lmutl/api/dto.
 * Keys are snake_case wherever the Java record carried @JsonProperty, because that is
 * the name the frontend actually sends.
 */
import type { Profile } from '../domain/types.js';
import type { SessionInfo } from '../domain/types.js';

export interface CreateProfileRequest {
  name: string;
}

export interface UpdateProfileRequest {
  name: string;
}

export interface ReorderProfilesRequest {
  profile_ids: string[];
}

export interface RenameSessionRequest {
  new_name: string;
}

export interface OpenPathRequest {
  path?: string | null;
  x?: number | null;
  y?: number | null;
  width?: number | null;
  height?: number | null;
}

export interface ImportPathsRequest {
  paths?: string[] | null;
  profile_id?: string | null;
}

export interface DiscordShareRequest {
  lap_number: number;
  title: string;
  content: string;
  attach_setup: boolean;
  car_class?: string | null;
  custom_car_model?: string | null;
  profile_id?: string | null;
  discord_handle?: string | null;
}

export interface DiscordDownloadRequest {
  profile_id?: string | null;
  telemetry_url?: string | null;
  telemetry_filename?: string | null;
  setup_url?: string | null;
  setup_filename?: string | null;
}

/** Re-exported so route modules can type their replies without importing domain twice. */
export type { Profile, SessionInfo };
