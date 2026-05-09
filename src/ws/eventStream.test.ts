import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import http from 'http';
import { WebSocket } from 'ws';
import { createEventStream } from './eventStream';

function createMockEventStreamService() {
  return {
    createStreamToken: vi.fn().mockResolvedValue('test-token'),
    consumeStreamToken: vi.fn().mockResolvedValue(null),
    logEvent: vi.fn().mockResolvedValue(1),
    getEventsSince: vi.fn().mockResolvedValue([]),
    pruneOldEvents: vi.fn().mockResolvedValue(0),
    pruneExpiredTokens: vi.fn().mockResolvedValue(0),
  };
}

describe('WebSocket Event Stream', () => {
  let server: http.Server;
  let mockService: ReturnType<typeof createMockEventStreamService>;
  let eventStream: ReturnType<typeof createEventStream>;
  let port: number;

  beforeEach(async () => {
    server = http.createServer();
    mockService = createMockEventStreamService();
    eventStream = createEventStream(server, mockService);

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        port = (server.address() as any).port;
        resolve();
      });
    });
  });

  afterEach(async () => {
    eventStream.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('rejects connections without a token', async () => {
    const ws = new WebSocket(`ws://localhost:${port}/api/v1/stream`);

    const error = await new Promise<any>((resolve) => {
      ws.on('error', resolve);
      ws.on('unexpected-response', (_req, res) => {
        resolve({ statusCode: res.statusCode });
      });
    });

    expect(error.statusCode).toBe(401);
  });

  it('rejects connections with invalid token', async () => {
    mockService.consumeStreamToken.mockResolvedValueOnce(null);

    const ws = new WebSocket(`ws://localhost:${port}/api/v1/stream?token=bad`);

    const error = await new Promise<any>((resolve) => {
      ws.on('error', resolve);
      ws.on('unexpected-response', (_req, res) => {
        resolve({ statusCode: res.statusCode });
      });
    });

    expect(error.statusCode).toBe(401);
  });

  it('accepts connections with valid token', async () => {
    mockService.consumeStreamToken.mockResolvedValueOnce({
      id: 1,
      token: 'valid',
      app_id: 5,
      community_did: null,
      expires_at: new Date(Date.now() + 60000),
    });

    const ws = new WebSocket(`ws://localhost:${port}/api/v1/stream?token=valid`);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });

    expect(eventStream.getClientCount()).toBe(1);
    ws.close();

    // Wait for close to propagate
    await new Promise((r) => setTimeout(r, 50));
    expect(eventStream.getClientCount()).toBe(0);
  });

  it('broadcasts events to connected clients', async () => {
    mockService.consumeStreamToken.mockResolvedValueOnce({
      id: 1,
      token: 'valid',
      app_id: 5,
      community_did: null,
      expires_at: new Date(Date.now() + 60000),
    });

    const ws = new WebSocket(`ws://localhost:${port}/api/v1/stream?token=valid`);
    await new Promise<void>((resolve) => ws.on('open', resolve));

    const messagePromise = new Promise<any>((resolve) => {
      ws.on('message', (data) => resolve(JSON.parse(data.toString())));
    });

    await eventStream.broadcast('member.joined', 'did:plc:test', { userDid: 'did:plc:user' });

    const msg = await messagePromise;
    expect(msg.type).toBe('member.joined');
    expect(msg.id).toBe(1);
    expect(msg.data.communityDid).toBe('did:plc:test');
    expect(msg.data.userDid).toBe('did:plc:user');

    ws.close();
  });

  it('filters events by community DID for scoped clients', async () => {
    mockService.consumeStreamToken.mockResolvedValueOnce({
      id: 1,
      token: 'valid',
      app_id: 5,
      community_did: 'did:plc:community1',
      expires_at: new Date(Date.now() + 60000),
    });

    const ws = new WebSocket(`ws://localhost:${port}/api/v1/stream?token=valid`);
    await new Promise<void>((resolve) => ws.on('open', resolve));

    const messages: any[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));

    // This should be filtered out (wrong community)
    await eventStream.broadcast('member.joined', 'did:plc:other', { userDid: 'did:plc:user1' });

    // This should arrive (matching community)
    mockService.logEvent.mockResolvedValueOnce(2);
    await eventStream.broadcast('member.joined', 'did:plc:community1', { userDid: 'did:plc:user2' });

    await new Promise((r) => setTimeout(r, 100));

    expect(messages.length).toBe(1);
    expect(messages[0].data.communityDid).toBe('did:plc:community1');

    ws.close();
  });

  it('replays missed events on reconnection with cursor, parsing string payloads', async () => {
    // Simulate what the DB returns: payload as JSON string (not parsed object)
    const missedEvents = [
      { id: 5, event_type: 'member.joined', community_did: 'did:plc:test', payload: '{"userDid":"did:plc:user1","communityDid":"did:plc:test"}', created_at: new Date() },
      { id: 6, event_type: 'member.left', community_did: 'did:plc:test', payload: '{"userDid":"did:plc:user2","communityDid":"did:plc:test"}', created_at: new Date() },
    ];
    mockService.getEventsSince.mockResolvedValueOnce(missedEvents);
    mockService.consumeStreamToken.mockResolvedValueOnce({
      id: 1,
      token: 'valid',
      app_id: 5,
      community_did: null,
      expires_at: new Date(Date.now() + 60000),
    });

    const ws = new WebSocket(`ws://localhost:${port}/api/v1/stream?token=valid&cursor=4`);

    const messages: any[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(data.toString())));

    await new Promise<void>((resolve) => ws.on('open', resolve));
    await new Promise((r) => setTimeout(r, 100));

    expect(messages.length).toBe(2);
    expect(messages[0].id).toBe(5);
    expect(messages[0].type).toBe('member.joined');
    // Verify payload was parsed from string into object (consistent with live frames)
    expect(messages[0].data).toEqual({ userDid: 'did:plc:user1', communityDid: 'did:plc:test' });
    expect(messages[1].id).toBe(6);
    expect(messages[1].type).toBe('member.left');
    expect(messages[1].data).toEqual({ userDid: 'did:plc:user2', communityDid: 'did:plc:test' });
    expect(mockService.getEventsSince).toHaveBeenCalledWith(4, undefined);

    ws.close();
  });
});
