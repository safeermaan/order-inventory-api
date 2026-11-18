import { writeFile } from 'node:fs/promises';
import pg from 'pg';
import { createApp } from '../src/app.js';
const db = new pg.Pool();
const app = await createApp(db,false);
await app.ready();
await writeFile('openapi/openapi.json',JSON.stringify(app.swagger(),null,2)+'\n');
await app.close(); await db.end();
