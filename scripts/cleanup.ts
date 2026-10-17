import { cleanup } from '../src/lib/server/cleanup';
import { db } from '../src/lib/server/db';
console.log(await cleanup());
await (await db()).close();
