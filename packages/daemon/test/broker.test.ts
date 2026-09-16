import { describe, expect, it, vi } from 'vitest';
import { DbRexError, type ClientRole, type DaemonMessage, type Event } from '@dbrex/core';
import { Broker, type ClientHandle } from '../src/broker';

interface Recorder extends ClientHandle {
  readonly received: DaemonMessage[];
}

let nextId = 1;

function client(role: ClientRole, label: string = role): Recorder {
  const received: DaemonMessage[] = [];
  return { id: nextId++, role, label, received, send: m => received.push(m) };
}

function interactions(c: Recorder): Extract<Event, { event: 'interaction' }>[] {
  return c.received.filter((m): m is Extract<Event, { event: 'interaction' }> =>
    'event' in m && m.event === 'interaction');
}

function closed(c: Recorder): number[] {
  return c.received
    .filter((m): m is Extract<Event, { event: 'interactionClosed' }> =>
      'event' in m && m.event === 'interactionClosed')
    .map(m => m.interactionId);
}

describe('secret prompts', () => {
  it('reaches ui and tty clients and never an agent', async () => {
    const broker = new Broker();
    const ui = client('ui');
    const tty = client('tty');
    const agent = client('agent');
    const script = client('headless');
    for (const c of [ui, tty, agent, script]) broker.attach(c);

    const asked = broker.askSecret('prod', 'Password for prod');

    expect(interactions(ui)).toHaveLength(1);
    expect(interactions(tty)).toHaveLength(1);
    expect(interactions(agent)).toHaveLength(0);
    expect(interactions(script)).toHaveLength(0);

    broker.reply(ui.id, interactions(ui)[0]!.interactionId, 'hunter2');
    await expect(asked).resolves.toBe('hunter2');
  });

  it('fails immediately when only an agent is attached', async () => {
    const broker = new Broker();
    broker.attach(client('agent'));

    // This is the whole reason the broker exists: an agent must not be able to
    // become the channel a password travels over, even when it is the only
    // client connected.
    await expect(broker.askSecret('prod', 'Password')).rejects.toMatchObject({
      code: 'auth_interaction_required',
    });
  });

  it('takes the first answer and tells the other clients to stop asking', async () => {
    const broker = new Broker();
    const first = client('ui', 'window-1');
    const second = client('ui', 'window-2');
    broker.attach(first);
    broker.attach(second);

    const asked = broker.askSecret('prod', 'Password');
    const id = interactions(first)[0]!.interactionId;
    broker.reply(first.id, id, 'answer');

    await expect(asked).resolves.toBe('answer');
    expect(closed(second)).toEqual([id]);
  });

  it('ignores a second answer to a settled interaction', async () => {
    const broker = new Broker();
    const a = client('ui', 'a');
    const b = client('ui', 'b');
    broker.attach(a);
    broker.attach(b);

    const asked = broker.askSecret('prod', 'Password');
    const id = interactions(a)[0]!.interactionId;
    broker.reply(a.id, id, 'first');
    broker.reply(b.id, id, 'second');

    await expect(asked).resolves.toBe('first');
  });

  it('ignores a reply from a client that was never asked', async () => {
    const broker = new Broker();
    const ui = client('ui');
    const agent = client('agent');
    broker.attach(ui);
    broker.attach(agent);

    const asked = broker.askSecret('prod', 'Password');
    const id = interactions(ui)[0]!.interactionId;
    broker.reply(agent.id, id, 'injected-by-the-agent');
    broker.reply(ui.id, id, 'typed-by-a-human');

    await expect(asked).resolves.toBe('typed-by-a-human');
  });

  it('fails once every asked client declines', async () => {
    const broker = new Broker();
    const a = client('ui', 'a');
    const b = client('tty', 'b');
    broker.attach(a);
    broker.attach(b);

    const asked = broker.askSecret('prod', 'Password');
    const id = interactions(a)[0]!.interactionId;
    broker.reply(a.id, id, undefined, true);
    broker.reply(b.id, id, undefined, true);

    await expect(asked).rejects.toMatchObject({ code: 'auth_interaction_required' });
  });

  it('fails when the last client able to answer disconnects', async () => {
    const broker = new Broker();
    const ui = client('ui');
    broker.attach(ui);

    const asked = broker.askSecret('prod', 'Password');
    broker.detach(ui.id);

    await expect(asked).rejects.toMatchObject({ code: 'auth_interaction_required' });
  });

  it('keeps waiting while another asked client is still attached', async () => {
    const broker = new Broker();
    const a = client('ui', 'a');
    const b = client('ui', 'b');
    broker.attach(a);
    broker.attach(b);

    const asked = broker.askSecret('prod', 'Password');
    broker.detach(a.id);
    broker.reply(b.id, interactions(b)[0]!.interactionId, 'still-here');

    await expect(asked).resolves.toBe('still-here');
  });
});

describe('browser interactions', () => {
  it('reaches an agent, which may relay a public single-use URL', async () => {
    const broker = new Broker();
    const agent = client('agent');
    broker.attach(agent);

    const asked = broker.askBrowser('analytics', 'https://idp.example/login?x=1', 'Trino login');
    const event = interactions(agent)[0]!;
    expect(event.detail).toMatchObject({ kind: 'browser', url: 'https://idp.example/login?x=1' });

    broker.reply(agent.id, event.interactionId, 'ok');
    await expect(asked).resolves.toBeUndefined();
  });

  it('is not offered to a headless client', async () => {
    const broker = new Broker();
    broker.attach(client('headless'));
    await expect(broker.askBrowser('analytics', 'https://idp', 'login'))
      .rejects.toMatchObject({ code: 'auth_interaction_required' });
  });
});

describe('timeouts', () => {
  it('gives up after the configured wait', async () => {
    vi.useFakeTimers();
    try {
      const broker = new Broker({ timeoutMs: 1_000 });
      const ui = client('ui');
      broker.attach(ui);

      const asked = broker.askSecret('prod', 'Password');
      const expectation = expect(asked).rejects.toMatchObject({ code: 'timeout' });
      await vi.advanceTimersByTimeAsync(1_001);
      await expectation;
      expect(closed(ui)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('diagnostics', () => {
  it('reports which attached clients could answer a prompt', () => {
    const broker = new Broker();
    broker.attach(client('agent'));
    broker.attach(client('ui'));
    expect(broker.interactiveClients().map(c => c.role)).toEqual(['ui']);
  });

  it('raises an DbRexError, not a bare Error, so clients can branch on the code', async () => {
    const broker = new Broker();
    await broker.askSecret('prod', 'Password').catch((e: unknown) => {
      expect(DbRexError.is(e)).toBe(true);
      expect((e as DbRexError).details.retryable).toBe(true);
    });
  });
});
