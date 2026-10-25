import type { OpenPathRequest } from '../../api/dto.js';
import { ApiException } from '../../api/error.js';
import type { Logger } from '../../lib/log.js';

/**
 * The native "open file" capability, supplied by the Electron main process
 * (`dialog.showOpenDialog`). Selected paths come back absolute, like JFileChooser's.
 */
export type NativeFileDialog = (request: OpenPathRequest) => Promise<string[]>;

/**
 * Compatibility implementation for POST /system/pick-and-upload.
 * Electron uses its native dialog + /system/import-paths instead.
 */
export class FilePicker {
  private readonly dialog: NativeFileDialog | null | undefined;
  private readonly logger: Logger;

  constructor(dialog: NativeFileDialog | null | undefined, logger: Logger) {
    this.dialog = dialog;
    this.logger = logger;
  }

  async pick(request: OpenPathRequest | null | undefined): Promise<string[]> {
    if (this.dialog === null || this.dialog === undefined) {
      throw new ApiException(400, 'Native file picker is unavailable in headless mode');
    }
    try {
      return await this.dialog(request ?? {});
    } catch (error) {
      this.logger.error({ err: error }, 'Native file picker failed');
      const message = error instanceof Error ? error.message : String(error);
      throw new ApiException(500, `Native file picker failed: ${message}`, { cause: error });
    }
  }
}
