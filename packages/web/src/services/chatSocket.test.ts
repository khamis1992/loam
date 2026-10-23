import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import type { AddressInfo } from 'node:net';
import { ChatSocket, shortUid } from './chatSocket.js';
import type { ServerEnvelope, ServerMessage } from '@shared/socket';

function makeEnvelope(sessionId: string, event: Record<string, unknown>): ServerEnvelope {
  const id = shortUid();
  return {
    id,
    type: 'event',
    sessionId,
    timestamp: Date.now(),
    event: { id, timestamp: Date.now(), ...event } as never,
  };
}

/** A persisted frame with its durable log sequence, so a replay can be sliced by seq. */
function makeSeqEnvelope(sessionId: string, event: Record<string, unknown>, seq: number): ServerEnvelope {
  return { ...makeEnvelope(sessionId, event), seq };
}

async function startMockServer() {
  const http = createServer();
  const io = new Server(http, { cors: { origin: '*' } });
  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    return token === 'valid-token' ? next() : next(new Error('unauthenticated'));
  });
  await new Promise<void>((resolve) => http.listen(0, resolve));
  const port = (http.address() as AddressInfo).port;

  const received: Record<string, unknown>[] = [];

  io.on('connection', (socket) => {
    socket.on('message', (m: Record<string, unknown>) => {
      received.push(m);
      if (m.type === 'join_session') {
        const sessionId = String(m.sessionId);
        socket.join(sessionId);
        const replay = [
          makeSeqEnvelope(sessionId, { type: 'chat', sender: 'user', content: 'older' }, 2),
          makeSeqEnvelope(sessionId, { type: 'chat', sender: 'assistant', content: 'hi' }, 3),
        ];
        // BUILD_SPEC §6.4: a client that sends `lastSeq` resumes by sequence,
        // otherwise it keeps the `lastMessageId` cursor behaviour.
        let from = 0;
        if (typeof m.lastSeq === 'number') {
          from = replay.findIndex((f) => (f.seq ?? 0) > (m.lastSeq as number));
          if (from < 0) from = replay.length;
        } else {
          const lastId = m.lastMessageId as string | undefined;
          from = lastId ? replay.findIndex((f) => f.id === lastId) + 1 : 0;
        }
        const delivered = replay.slice(from);
        const lastSeq = delivered.length ? delivered[delivered.length - 1]!.seq : undefined;
        socket.emit('message', {
          id: shortUid(),
          type: 'event',
          sessionId,
          timestamp: Date.now(),
          ...(typeof lastSeq === 'number' ? { seq: lastSeq } : {}),
          event: {
            id: shortUid(),
            type: 'eventsNotifyEventsAfter',
            timestamp: Date.now(),
            events: delivered.map((f) => f.event),
            noPersistent: true,
          },
        });
      }
    });
  });

  return {
    url: `http://127.0.0.1:${port}`,
    http,
    io,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        io.close(() => http.close(() => resolve()));
      }),
  };
}

describe('ChatSocket', () => {
  let server: Awaited<ReturnType<typeof startMockServer>>;

  beforeEach(async () => {
    server = await startMockServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('connects and receives server envelopes', async () => {
    const messages: ServerMessage[] = [];
    const client = new ChatSocket({
      getToken: async () => 'valid-token',
      onMessage: (m: ServerMessage) => messages.push(m),
      socketBase: server.url,
      clientVersion: '0.1.0',
    });

    await client.connect();
    await new Promise((r) => setTimeout(r, 50));

    const sessionId = shortUid();
    client.join(sessionId);
    await new Promise((r) => setTimeout(r, 100));

    server.io.to(sessionId).emit('message', makeEnvelope(sessionId, { type: 'liveStatus', text: 'Thinking' }));

    await new Promise((r) => setTimeout(r, 100));
    const liveStatusMessages = messages.filter(
      (m) => (m as ServerEnvelope).event?.type === 'liveStatus',
    );
    expect(liveStatusMessages).toHaveLength(1);
    expect(liveStatusMessages[0]).toMatchObject({ type: 'event', sessionId });
    expect((liveStatusMessages[0] as ServerEnvelope).event.type).toBe('liveStatus');

    client.disconnect();
  });

  it('sends join_session v2 and replays events after lastMessageId', async () => {
    const messages: ServerMessage[] = [];
    const client = new ChatSocket({
      getToken: async () => 'valid-token',
      onMessage: (m: ServerMessage) => messages.push(m),
      socketBase: server.url,
    });

    await client.connect();
    await new Promise((r) => setTimeout(r, 50));

    const sessionId = shortUid();
    client.join(sessionId, undefined);
    await new Promise((r) => setTimeout(r, 100));

    expect(server.received).toHaveLength(1);
    expect(server.received[0]).toMatchObject({ type: 'join_session', sessionId, version: 2 });

    const replayFrame = messages.find(
      (m) => (m as ServerEnvelope).event?.type === 'eventsNotifyEventsAfter',
    ) as ServerEnvelope | undefined;
    expect(replayFrame).toBeDefined();
    expect(((replayFrame!.event as any).events as unknown[]).length).toBeGreaterThan(0);

    client.disconnect();
  });

  it('re-joins with the dynamic lastMessageId getter on reconnect', async () => {
    const client = new ChatSocket({
      getToken: async () => 'valid-token',
      onMessage: () => undefined,
      socketBase: server.url,
    });

    await client.connect();
    await new Promise((r) => setTimeout(r, 50));

    const sessionId = shortUid();
    client.join(sessionId, 'static-id', () => 'dynamic-id');
    await new Promise((r) => setTimeout(r, 100));

    expect(server.received[0]).toMatchObject({ lastMessageId: 'static-id' });

    // Invoke the private rejoin closure to simulate the reconnect path.
    (client as unknown as { rejoin?: () => void }).rejoin?.();
    await new Promise((r) => setTimeout(r, 50));

    const rejoins = server.received.filter((m) => m.type === 'join_session');
    expect(rejoins.length).toBe(2);
    expect(rejoins[rejoins.length - 1]).toMatchObject({ lastMessageId: 'dynamic-id' });

    client.disconnect();
  });

  it('sends stop_session', async () => {
    const client = new ChatSocket({
      getToken: async () => 'valid-token',
      onMessage: () => undefined,
      socketBase: server.url,
    });

    await client.connect();
    await new Promise((r) => setTimeout(r, 50));

    const sessionId = shortUid();
    client.stop(sessionId);
    await new Promise((r) => setTimeout(r, 50));

    const stop = server.received.find((m) => m.type === 'stop_session');
    expect(stop).toMatchObject({ sessionId });

    client.disconnect();
  });

  it('replays only frames after the last durable log seq', async () => {
    const messages: ServerMessage[] = [];
    const client = new ChatSocket({
      getToken: async () => 'valid-token',
      onMessage: (m: ServerMessage) => messages.push(m),
      socketBase: server.url,
    });

    await client.connect();
    await new Promise((r) => setTimeout(r, 50));

    const sessionId = shortUid();
    client.join(sessionId, undefined, undefined, () => 2);
    await new Promise((r) => setTimeout(r, 100));

    expect(server.received[0]).toMatchObject({ lastSeq: 2 });

    const replayFrame = messages.find(
      (m) => (m as ServerEnvelope).event?.type === 'eventsNotifyEventsAfter',
    ) as ServerEnvelope | undefined;
    expect(replayFrame).toBeDefined();
    // seq 2 is already rendered, so only seq 3 comes back.
    expect((replayFrame!.event as any).events).toHaveLength(1);
    expect(((replayFrame!.event as any).events as any[])[0]).toMatchObject({ content: 'hi' });
    expect(replayFrame!.seq).toBe(3);

    client.disconnect();
  });

  it('records observed frame seqs and resumes from them on reconnect', async () => {
    const messages: ServerMessage[] = [];
    const client = new ChatSocket({
      getToken: async () => 'valid-token',
      onMessage: (m: ServerMessage) => messages.push(m),
      socketBase: server.url,
    });

    await client.connect();
    await new Promise((r) => setTimeout(r, 50));

    const sessionId = shortUid();
    client.join(sessionId, undefined);
    await new Promise((r) => setTimeout(r, 100));

    // Every observed frame updates the per-session cursor.
    client.noteSeq(sessionId, 5);

    (client as unknown as { rejoin?: () => void }).rejoin?.();
    await new Promise((r) => setTimeout(r, 50));

    const rejoins = server.received.filter((m) => m.type === 'join_session');
    expect(rejoins[rejoins.length - 1]).toMatchObject({ lastSeq: 5 });

    client.disconnect();
  });

  it('stops observing after disconnect and after unsubscribe', async () => {
    const messages: ServerMessage[] = [];
    const client = new ChatSocket({
      getToken: async () => 'valid-token',
      onMessage: () => undefined,
      socketBase: server.url,
    });

    await client.connect();
    await new Promise((r) => setTimeout(r, 50));

    const seen: ServerMessage[] = [];
    const off = client.onMessage((m: ServerMessage) => seen.push(m));

    const sessionId = shortUid();
    client.join(sessionId, undefined);
    await new Promise((r) => setTimeout(r, 100));
    expect(seen.some((m) => (m as ServerEnvelope).event?.type === 'eventsNotifyEventsAfter')).toBe(true);

    off();
    const afterUnsubscribe = seen.length;

    server.io.to(sessionId).emit('message', makeEnvelope(sessionId, { type: 'liveStatus', text: 'Thinking' }));
    await new Promise((r) => setTimeout(r, 100));
    expect(seen).toHaveLength(afterUnsubscribe);

    client.disconnect();
    server.io.to(sessionId).emit('message', makeEnvelope(sessionId, { type: 'liveStatus', text: 'Done' }));
    await new Promise((r) => setTimeout(r, 100));
    expect(messages).toHaveLength(0);
    expect(seen).toHaveLength(afterUnsubscribe);
  });
});
