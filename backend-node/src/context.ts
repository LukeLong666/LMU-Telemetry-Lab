import { Env, loadEnv } from './config/env.js';
import { createLogger, Logger } from './lib/log.js';
import { AppPaths } from './infra/fs/app-paths.js';
import { ProfileRepository } from './infra/fs/profile-repository.js';
import { SessionRepository } from './infra/fs/session-repository.js';
import { DuckDbConnectionFactory } from './infra/duckdb/connection.js';
import { MetadataReader } from './infra/duckdb/metadata.js';
import { TrackRegistry } from './infra/track/track-registry.js';
import { CarCatalog } from './infra/car/car-catalog.js';
import { FusionEngine } from './infra/fusion/fusion-engine.js';
import { DiscordConfig, DiscordLogSink } from './infra/discord/config.js';
import { DiscordClient } from './infra/discord/client.js';
import { FilePicker, NativeFileDialog } from './infra/system/file-picker.js';
import { SteeringWheelScanner } from './infra/system/steering-wheel-scanner.js';
import { ProfileService } from './application/profile-service.js';
import { SessionService } from './application/session-service.js';
import { ReferenceLapService } from './application/reference-lap-service.js';
import { LapService } from './application/lap-service.js';
import { TelemetryService } from './application/telemetry-service.js';
import { Track3DService } from './application/track3d-service.js';
import { SetupService } from './application/setup-service.js';
import { SvmExporter } from './application/svm-exporter.js';
import { LapExportService } from './application/lap-export-service.js';
import { DiscordService } from './application/discord-service.js';
import { SystemService } from './application/system-service.js';

export interface AppContextOptions {
  env?: Partial<Env>;
  logger?: Logger;
  /** Electron's `dialog.showOpenDialog` bridge; absent in headless mode. */
  fileDialog?: NativeFileDialog | null;
}

export interface AppContext {
  env: Env;
  logger: Logger;
  paths: AppPaths;
  profileService: ProfileService;
  sessionService: SessionService;
  referenceLapService: ReferenceLapService;
  lapService: LapService;
  telemetryService: TelemetryService;
  track3DService: Track3DService;
  setupService: SetupService;
  svmExporter: SvmExporter;
  lapExportService: LapExportService;
  discordService: DiscordService;
  systemService: SystemService;
  /** `SetupController` and `SystemService` use these directly, as Java does. */
  sessionRepository: SessionRepository;
  carCatalog: CarCatalog;
}

/**
 * Composition root. The Java backend gets this from the Spring container; here the graph is
 * assembled explicitly so the infra -> application -> api layering stays visible.
 *
 * Asynchronous only because `ProfileService.init()` (Java's `@PostConstruct`) must finish
 * before the first request: it creates the guest profile and migrates legacy profile data.
 */
export async function buildContext(options: AppContextOptions = {}): Promise<AppContext> {
  const env: Env = { ...loadEnv(), ...options.env };
  const logger = options.logger ?? createLogger(env.logFile, env.appHome);
  const paths = new AppPaths(env, logger);
  paths.init();

  const discordLog = toDiscordLog(logger);
  const connections = new DuckDbConnectionFactory();
  const metadataReader = new MetadataReader(logger);
  const trackRegistry = new TrackRegistry(logger);
  const carCatalog = new CarCatalog();
  const discordConfig = new DiscordConfig(paths, { env: process.env, logger: discordLog });
  const discordClient = new DiscordClient(discordConfig, { logger: discordLog });

  const profileRepository = new ProfileRepository(paths, logger);
  const sessionRepository = new SessionRepository(paths, discordClient, logger);

  const lapService = new LapService(
    connections,
    metadataReader,
    trackRegistry,
    carCatalog,
    logger,
  );
  const profileService = new ProfileService(profileRepository, paths, logger);
  const sessionService = new SessionService(sessionRepository, lapService, trackRegistry, logger);
  const referenceLapService = new ReferenceLapService(sessionRepository, lapService, logger);

  const fusionEngine = new FusionEngine(connections, metadataReader, trackRegistry, carCatalog, logger);
  const telemetryService = new TelemetryService(sessionService, lapService, fusionEngine);
  const track3DService = new Track3DService(sessionService, lapService, fusionEngine);
  const setupService = new SetupService(sessionService, connections, metadataReader);
  const svmExporter = new SvmExporter(connections, metadataReader);
  const lapExportService = new LapExportService(
    sessionService,
    lapService,
    setupService,
    carCatalog,
    connections,
    paths,
    logger,
  );
  const discordService = new DiscordService(
    discordConfig,
    discordClient,
    sessionService,
    lapService,
    lapExportService,
    svmExporter,
    setupService,
    carCatalog,
    paths,
    logger,
  );

  const filePicker = new FilePicker(options.fileDialog ?? null, logger);
  const steeringWheelScanner = new SteeringWheelScanner(paths);
  const systemService = new SystemService(
    sessionRepository,
    filePicker,
    steeringWheelScanner,
    paths,
    logger,
  );

  await profileService.init();

  return {
    env,
    logger: logger.child({ module: 'app' }),
    paths,
    profileService,
    sessionService,
    referenceLapService,
    lapService,
    telemetryService,
    track3DService,
    setupService,
    svmExporter,
    lapExportService,
    discordService,
    systemService,
    sessionRepository,
    carCatalog,
  };
}

/** pino is `(obj, message)`; the Discord layer's sink is `(message, meta)`. */
function toDiscordLog(logger: Logger): DiscordLogSink {
  return {
    info: (message, meta) => logger.info(meta ?? {}, message),
    warn: (message, meta) => logger.warn(meta ?? {}, message),
    error: (message, meta) => logger.error(meta ?? {}, message),
  };
}
