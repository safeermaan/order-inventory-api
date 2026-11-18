import { createApp } from './app.js';
import { pool } from './db.js';
import { config } from './config.js';
import { startWorker } from './workers/expiry.js';
const app = await createApp(pool);
pool.on('error', err => app.log.error({ err, reqId: 'database' },'Idle database connection failed'));
const stopWorker = startWorker(pool,config.WORKER_INTERVAL_MS,app.log);
app.addHook('onClose', async () => { await stopWorker(); await pool.end(); });
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => {
 const timeout = setTimeout(() => process.exit(1),10000); timeout.unref();
 void app.close().then(() => { clearTimeout(timeout); }).catch(err => { app.log.error({ err },'Shutdown failed'); process.exitCode=1; });
});
await app.listen({ port: config.PORT, host: '0.0.0.0' });
