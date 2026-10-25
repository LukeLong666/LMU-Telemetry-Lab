import fs from 'node:fs/promises';
import path from 'node:path';
import { isDirectory } from '../fs/atomic-files.js';
import type { AppPaths } from '../fs/app-paths.js';

export interface SteeringWheelEntry {
  name: string;
  path: string;
}

export interface SteeringWheelScan {
  categories: Record<string, SteeringWheelEntry[]>;
}

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'];
/** Java walks with Files.walk(root, 6). */
const MAX_DEPTH = 6;

function isImage(fileName: string): boolean {
  const lower = fileName.toLowerCase();
  return IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

/** Mirrors String.CASE_INSENSITIVE_ORDER; Array.sort is stable so equal names keep walk order. */
function caseInsensitiveCompare(a: string, b: string): number {
  const left = a.toUpperCase();
  const right = b.toUpperCase();
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export class SteeringWheelScanner {
  private readonly paths: AppPaths;

  constructor(paths: AppPaths) {
    this.paths = paths;
  }

  async scan(): Promise<SteeringWheelScan> {
    const root = path.resolve(this.paths.steeringWheelDir);
    if (!isDirectory(root)) {
      return { categories: {} };
    }

    const categories = new Map<string, SteeringWheelEntry[]>();
    try {
      await this.collect(root, root, 1, categories);
    } catch {
      return { categories: {} };
    }

    // Java collects into a TreeMap, so categories come out in ascending name order.
    const ordered = new Map<string, SteeringWheelEntry[]>();
    for (const category of [...categories.keys()].sort()) {
      const wheels = (categories.get(category) ?? []).slice().sort((a, b) => caseInsensitiveCompare(a.name, b.name));
      ordered.set(category, wheels);
    }
    const result: Record<string, SteeringWheelEntry[]> = {};
    for (const [category, wheels] of ordered) {
      result[category] = wheels;
    }
    return { categories: result };
  }

  /** `level` is how many path segments the entries of `dir` have, matching Files.walk depth 6. */
  private async collect(
    root: string,
    dir: string,
    level: number,
    categories: Map<string, SteeringWheelEntry[]>,
  ): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile()) {
        if (!isImage(entry.name)) {
          continue;
        }
        const relative = path.relative(root, full);
        const parent = path.dirname(relative);
        // Java: relative.getParent() == null for a top-level image.
        const category = parent === '' || parent === '.' ? 'Root' : parent;
        const fileName = path.basename(full);
        const name = fileName.slice(0, fileName.lastIndexOf('.'));
        const wheelPath = relative.split(path.sep).join('/');
        const bucket = categories.get(category);
        if (bucket === undefined) {
          categories.set(category, [{ name, path: wheelPath }]);
        } else {
          bucket.push({ name, path: wheelPath });
        }
      } else if (entry.isDirectory() && level < MAX_DEPTH) {
        await this.collect(root, full, level + 1, categories);
      }
    }
  }
}
