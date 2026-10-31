import { createServer, type Socket } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import webPush from 'web-push';

export async function startHarness({ push = false }: { push?: boolean } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'printhive-e2e-'));
  const messages: string[] = [], sockets = new Set<Socket>();
  let rejectMail = false;
  const smtp = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {});
    socket.setEncoding('utf8'); socket.write('220 localhost ESMTP test sink\r\n');
    let buffer = '', inData = false, message = '';
    socket.on('data', data => {
      buffer += data;
      let index: number;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === '.') { messages.push(message.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))); inData = false; message = ''; socket.write('250 queued\r\n'); }
          else message += line + '\r\n';
        } else if (/^EHLO|^HELO/i.test(line)) socket.write('250-localhost\r\n250 PIPELINING\r\n');
        else if (/^DATA/i.test(line)) { if (rejectMail) socket.write('550 Test delivery rejection\r\n'); else { inData = true; socket.write('354 End with dot\r\n'); } }
        else if (/^QUIT/i.test(line)) socket.end('221 Bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });
  await new Promise<void>(resolve => smtp.listen(0, '127.0.0.1', resolve));
  const smtpPort = (smtp.address() as { port: number }).port;
  const portServer = createServer(); await new Promise<void>(resolve => portServer.listen(0, '127.0.0.1', resolve));
  const port = (portServer.address() as { port: number }).port;
  await new Promise<void>(resolve => portServer.close(() => resolve()));
  const origin = `http://127.0.0.1:${port}`;
  const pushKeys = push ? webPush.generateVAPIDKeys() : null;
  const env = { ...process.env, NODE_ENV: 'test', APP_ORIGIN: origin, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dir,
    CONFIRMATION_SECRET: randomBytes(32).toString('hex'), SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtpPort), SMTP_SECURE: 'false',
    SMTP_USERNAME: '', SMTP_PASSWORD: '', SMTP_FROM: 'PrintHive <test@example.test>', TRUST_PROXY: 'false',
    VAPID_PUBLIC_KEY: pushKeys?.publicKey ?? '', VAPID_PRIVATE_KEY: pushKeys?.privateKey ?? '', VAPID_SUBJECT: push ? 'mailto:operator@example.test' : '' };
  async function run(args: string[], input?: string) {
    const proc = Bun.spawn([process.execPath, ...args], { env, stdout: 'pipe', stderr: 'pipe', stdin: input === undefined ? 'ignore' : new Blob([input]) });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code) throw new Error(stderr);
  }
  await run(['scripts/migrate.ts']); await run(['scripts/operator.ts', 'operator'], 'test-password-12345');
  let child: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
  let output = '';
  let drains: Promise<void>[] = [];
  async function collect(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader(), decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output += decoder.decode(value, { stream: true });
      }
      output += decoder.decode();
    } finally { reader.releaseLock(); }
  }
  async function start() {
    child = Bun.spawn([process.execPath, 'dist/server/entry.mjs'], { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const current = child;
    drains = [collect(current.stdout), collect(current.stderr)];
    for (let i = 0; i < 120; i++) {
      try { if ((await fetch(origin + '/api/health')).ok) return; } catch { /* Starting. */ }
      if (current.exitCode !== null) throw new Error('Server exited: ' + output);
      await Bun.sleep(50);
    }
    throw new Error('Server did not become healthy: ' + output);
  }
  async function stop() { if (child) { child.kill(); await child.exited; await Promise.all(drains); child = undefined; } }
  async function close() { await stop(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => smtp.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
  try { await start(); } catch (e) { await close(); throw e; }
  return { origin, dir, messages, logs: () => output, rejectMail: (reject: boolean) => { rejectMail = reject; }, restart: async () => { await stop(); await start(); }, close };
}
