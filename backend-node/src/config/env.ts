import path from 'node:path';

/**
 * Mirrors Java's AppProperties + application.yml. Environment variable names are
 * kept identical to the Java/Python backends so Electron and the Vite proxy need
 * no per-backend special casing.
 */
export interface Env {
  port: number;
  address: string;
  devMode: boolean;
  dataDir: string;
  telemetryDir: string;
  frontendDir: string;
  steeringWheelDir: string;
  version: string;
  logFile: string;
  appHome: string;
}

function str(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

function bool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return value.toLowerCase() !== 'false' && value !== '0';
}

function num(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value.trim(), 10);
  return Number.isNaN(parsed) ? fallback : parsed;
}

export function loadEnv(): Env {
  return {
    port: num('SERVER_PORT', 8000),
    address: str('LMU_SERVER_ADDRESS', '127.0.0.1'),
    devMode: bool('LMU_DEV_MODE', true),
    dataDir: str('APP_DATA_DIR', ''),
    telemetryDir: str(
      'LMU_TELEMETRY_DIR',
      'D:\\Program Files (x86)\\Steam\\steamapps\\common\\Le Mans Ultimate\\UserData\\Telemetry',
    ),
    frontendDir: str('LMU_FRONTEND_DIR', '../frontend/dist'),
    steeringWheelDir: str('LMU_STEERING_WHEEL_DIR', '../frontend/public/steering wheel'),
    version: str('LMU_VERSION', '1.5.3'),
    logFile: str('LMU_LOG_FILE', 'backend_debug.log'),
    appHome: path.resolve(str('LMU_HOME', process.cwd())),
  };
}
