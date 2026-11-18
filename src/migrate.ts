import { runner } from 'node-pg-migrate';
import { config } from './config.js';
await runner({ databaseUrl: config.DATABASE_URL, direction: 'up', migrationsTable: 'pgmigrations', dir: 'migrations', log: () => {} });
console.log(JSON.stringify({ level: 'info', reqId: 'migrations', message: 'Database migrations complete' }));
