import { describe, expect, it } from 'vitest';
import { createJennifer } from '../../src/app.js';
import { buildServer } from '../../src/api/server.js';

describe('Home Screen app boot reports', () => {
  it('accepts small plain-text beacons without sign-in, shows them only to the owner, and rejects junk', async () => {
    const j = createJennifer({ config: {} as never, inventoryPath: null as never });
    const app = buildServer(j, { tokens: { 'owner-token-0123456789': 'owner' } });
    const html = (await app.inject({ method: 'GET', url: '/' })).body;
    expect(html).toContain('Loading Jennifer…');
    const hello = (await app.inject({ method: 'GET', url: '/hello' })).body;
    expect(hello).toContain('It works');
    expect(hello).not.toContain('manifest');
    expect(html).toContain("send('html')");
    const beacon = (body: string) => app.inject({ method: 'POST', url: '/v1/client-log', headers: { 'content-type': 'text/plain' }, payload: body });
    expect((await beacon(JSON.stringify({ stage: 'error', msg: "Can't find variable: foo @:12:3", mode: 'home-screen app', ua: 'iPhone', path: '/', ms: 42 }))).statusCode).toBe(204);
    expect((await beacon('not json')).statusCode).toBe(400);
    expect((await beacon(JSON.stringify({ stage: 'steal', msg: 'x', mode: 'x', ua: 'x', path: '/', ms: 1 }))).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/v1/client-log' })).statusCode).toBe(401);
    const log = (await app.inject({ method: 'GET', url: '/v1/client-log', headers: { authorization: 'Bearer owner-token-0123456789' } })).json();
    expect(log).toEqual([expect.objectContaining({ stage: 'error', mode: 'home-screen app' })]);
  });
});
