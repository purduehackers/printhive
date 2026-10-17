import { migrate, db } from '../src/lib/server/db';
await migrate();
await (await db()).close();
console.log('Database migrations applied.');
