import { buildApp } from './app.js';
import { loadConfig } from './config.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const { app } = buildApp({
    logger: true,
    dbFile: config.dbFile,
    allowedWorkspaceRoots: [config.workspacesRoot],
    config,
  });
  try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info(`Easy BI Studio service listening on http://${config.host}:${config.port}`);
    app.log.info(`Workspaces root: ${config.workspacesRoot}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

void main();
