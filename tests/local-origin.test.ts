import { afterEach, describe, expect, test } from 'bun:test';
import { appOrigin, checkOrigin } from '../src/lib/server/http';

const saved = { APP_ORIGIN: process.env.APP_ORIGIN, NODE_ENV: process.env.NODE_ENV };
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
const request = (origin?: string, target = 'http://localhost:4321') => new Request(target + '/api/login', {
  method: 'POST', headers: origin ? { Origin: origin } : {},
});

describe('local development origins', () => {
  test('accepts both Astro ports and loopback aliases for local operator testing', () => {
    process.env.NODE_ENV = 'development';
    for (const configured of ['http://localhost:4321', 'http://localhost:4322']) {
      process.env.APP_ORIGIN = configured;
      for (const host of ['localhost', '127.0.0.1', '[::1]']) {
        for (const port of [4321, 4322]) {
          const origin = `http://${host}:${port}`;
          expect(() => checkOrigin(request(origin))).not.toThrow();
          expect(() => checkOrigin(request(configured, origin))).not.toThrow();
          expect(appOrigin(request(configured, origin))).toBe(origin);
        }
      }
    }
  });
  test('rejects missing, foreign, lookalike and other-port origins', () => {
    process.env.NODE_ENV = 'development'; process.env.APP_ORIGIN = 'http://localhost:4321';
    for (const origin of [undefined, 'null', 'https://evil.test', 'http://localhost.evil.test:4321', 'http://localhost:4323'])
      expect(() => checkOrigin(request(origin))).toThrow();
    expect(() => checkOrigin(request('http://localhost:4322', 'http://evil.test'))).toThrow();
  });
  test('keeps exact-origin enforcement for production and nonlocal development', () => {
    for (const mode of ['development', 'production']) {
      process.env.NODE_ENV = mode; process.env.APP_ORIGIN = 'https://prints.test';
      expect(() => checkOrigin(request('https://prints.test', 'https://prints.test'))).not.toThrow();
      expect(appOrigin(request('https://prints.test', 'http://localhost:4322'))).toBe('https://prints.test');
      for (const origin of ['http://localhost:4321', 'http://localhost:4322', 'https://other.test'])
        expect(() => checkOrigin(request(origin, 'https://prints.test'))).toThrow();
    }
    process.env.APP_ORIGIN = 'https://localhost:4321';
    expect(() => checkOrigin(request('http://localhost:4322', 'https://localhost:4321'))).toThrow();
  });
});
