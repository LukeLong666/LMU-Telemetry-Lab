import { createApp } from './app.js';

async function main(): Promise<void> {
  const { app, ctx } = await createApp();

  const shutdown = (signal: string) => {
    ctx.logger.info({ signal }, 'Shutting down');
    app
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await app.listen({ host: ctx.env.address, port: ctx.env.port });
    ctx.logger.info({ address: ctx.env.address, port: ctx.env.port }, 'Node backend listening');
  } catch (error) {
    ctx.logger.error({ err: error }, 'Node backend failed to start');
    process.exit(1);
  }
}

void main();
