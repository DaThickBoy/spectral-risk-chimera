import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { DashboardIndexResponse, DashboardViewResponse } from '../../src/shared/apiContracts/index.js';
import { App } from '../../src/web/App.tsx';
import type { LiveUpdateHooks } from '../../src/web/data/liveUpdates.js';
import type { Loaded } from '../../src/web/data/source.js';
import { demoIndex, multiCurrencyView } from './fixtures.js';
import { memorySource } from './render.js';

const [a, b] = demoIndex().portfolios.map(({ id }) => id) as [string, string];

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected a queued request or mounted control');
  return value;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function ok<T>(value: T): Loaded<T> {
  return { ok: true, value };
}

function view(asOfDate: string): Loaded<DashboardViewResponse> {
  const fixture = multiCurrencyView();
  return ok({ ...fixture, freshness: { ...fixture.freshness, asOfDate } });
}

async function complete<T>(request: ReturnType<typeof deferred<T>>, result: T) {
  await act(async () => {
    request.resolve(result);
  });
}

const cleanup = new Set<() => void>();
afterEach(() => {
  for (const unmount of cleanup) unmount();
});

async function start() {
  const indexes: ReturnType<typeof deferred<Loaded<DashboardIndexResponse>>>[] = [];
  const views: ReturnType<typeof deferred<Loaded<DashboardViewResponse>>>[] = [];
  const source = memorySource({
    index: () => {
      const request = deferred<Loaded<DashboardIndexResponse>>();
      indexes.push(request);
      return request.promise;
    },
    view: () => {
      const request = deferred<Loaded<DashboardViewResponse>>();
      views.push(request);
      return request.promise;
    },
  });
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const unmount = () => {
    cleanup.delete(unmount);
    act(() => root.unmount());
    container.remove();
  };
  cleanup.add(unmount);
  let hooks: LiveUpdateHooks | undefined;
  await act(async () =>
    root.render(
      <App
        source={source}
        liveUpdates={(next) => {
          hooks = next;
          const status = { state: 'DISCONNECTED', attempt: 0, invalidMessages: 0 } as const;
          const providers = [] as const;
          return {
            start() {},
            stop() {},
            status: () => status,
            subscribeStatus: () => () => {},
            sentiment: () => undefined,
            subscribeSentiment: () => () => {},
            providers: () => providers,
            subscribeProviders: () => () => {},
          };
        }}
      />,
    ),
  );
  return {
    invalidate: (id: string) =>
      act(async () => {
        await required(hooks).refresh(id);
      }),
    container,
    unmount,
    indexes,
    views,
    source,
    text: () => container.textContent ?? '',
    select: async (id: string) => {
      const select = required(container.querySelector<HTMLSelectElement>('#portfolio-select'));
      await act(async () => {
        select.value = id;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
    },
    reload: async () => {
      const button = required(
        [...container.querySelectorAll('button')].find((el) => el.textContent === 'Reload'),
      );
      await act(async () => button.click());
    },
  };
}

describe('portfolio request ownership', () => {
  it('ignores the first A response while the second A is pending and a late B error after it succeeds', async () => {
    const app = await start();
    await complete(required(app.indexes[0]), ok(demoIndex()));
    await app.select(b);
    await app.select(a);
    expect(app.source.calls.filter((call) => call.startsWith('view:'))).toEqual([
      `view:${a}`,
      `view:${b}`,
      `view:${a}`,
    ]);

    await complete(required(app.views[0]), view('2026-10-01'));
    expect(app.text()).toContain('Loading portfolio data…');
    expect(app.text()).not.toContain('Market data as of 2026-10-01');

    await complete(required(app.views[2]), view('2026-10-03'));
    await complete(required(app.views[1]), { ok: false, error: 'NETWORK' });
    expect(app.text()).toContain('Market data as of 2026-10-03');
    expect(app.container.querySelector('[role="alert"]')).toBeNull();
  });

  it('ignores superseded index and view results across consecutive reloads', async () => {
    const app = await start();
    await complete(required(app.indexes[0]), ok(demoIndex()));
    await complete(required(app.views[0]), view('2026-10-01'));
    expect(app.text()).toContain('Market data as of 2026-10-01');

    await app.reload();
    expect(app.text()).toContain('Loading portfolio data…');
    expect(app.text()).not.toContain('Market data as of 2026-10-01');
    await app.reload();

    await complete(required(app.indexes[2]), ok(demoIndex()));
    await complete(required(app.views[2]), view('2026-10-03'));
    await complete(required(app.indexes[1]), { ok: false, error: 'NETWORK' });
    await complete(required(app.views[1]), view('2026-10-02'));
    expect(app.text()).toContain('Market data as of 2026-10-03');
    expect(app.text()).not.toContain('Market data as of 2026-10-02');
    expect(app.container.querySelector('[role="alert"]')).toBeNull();
  });

  it('shows the current view error and clears it immediately on a retry', async () => {
    const app = await start();
    await complete(required(app.indexes[0]), ok(demoIndex()));
    await complete(required(app.views[0]), { ok: false, error: 'NOT_FOUND' });
    expect(app.container.querySelector('[role="alert"]')?.textContent).toContain('No data was found');

    await app.reload();
    expect(app.container.querySelector('[role="alert"]')).toBeNull();
    expect(app.text()).toContain('Loading portfolio data…');
    await complete(required(app.indexes[1]), ok(demoIndex()));
    await complete(required(app.views[1]), view('2026-10-02'));
    expect(app.text()).toContain('Market data as of 2026-10-02');
  });

  it('does not start a view when the initial index completes after unmount', async () => {
    const app = await start();
    app.unmount();
    await complete(required(app.indexes[0]), ok(demoIndex()));
    expect(app.views).toHaveLength(0);
  });

  it('clears the previous index error while a reload is pending', async () => {
    const app = await start();
    await complete(required(app.indexes[0]), { ok: false, error: 'NETWORK' });
    expect(app.container.querySelector('[role="alert"]')?.textContent).toContain(
      'The data could not be reached',
    );

    await app.reload();
    expect(app.container.querySelector('[role="alert"]')).toBeNull();
    expect(app.text()).toContain('Loading portfolio data…');
    await complete(required(app.indexes[1]), ok(demoIndex()));
    await complete(required(app.views[0]), view('2026-10-01'));
    expect(app.text()).toContain('Market data as of 2026-10-01');
  });
});

it('retains and coalesces invalidations during foreground loads, including a failed reload', async () => {
  const app = await start();
  await complete(required(app.indexes[0]), ok(demoIndex()));
  await app.invalidate(a);
  await app.invalidate(a);
  expect(app.views).toHaveLength(1);
  await complete(required(app.views[0]), view('2026-10-01'));
  expect(app.views).toHaveLength(2);
  await complete(required(app.views[1]), view('2026-10-02'));
  expect(app.text()).toContain('2026-10-02');
  await app.reload();
  await app.invalidate(a);
  await complete(required(app.views[2]), { ok: false, error: 'NOT_FOUND' });
  await complete(required(app.views[3]), view('2026-10-03'));
  expect(app.text()).toContain('2026-10-03');
  await app.select(b);
  await app.invalidate(a);
  await app.invalidate(b);
  await app.unmount();
  await complete(required(app.views[4]), view('2026-10-04'));
  expect(app.views).toHaveLength(5);
});

for (const transition of ['reload', 'switch'] as const) {
  it('drains one pending invalidation after successful ' + transition, async () => {
    const app = await start();
    await complete(required(app.indexes[0]), ok(demoIndex()));
    const current = transition === 'switch' ? b : a;
    if (transition === 'switch') await app.select(b);
    else await app.reload();
    await app.invalidate(current);
    await app.invalidate(current);
    if (transition === 'switch') await app.invalidate(a);
    expect(app.views).toHaveLength(2);
    await complete(required(app.views[1]), view('2026-10-08'));
    expect(app.views).toHaveLength(3);
    await complete(required(app.views[2]), view('2026-10-09'));
    await complete(required(app.views[0]), view('2026-10-07'));
    expect(app.text()).toContain('2026-10-09');
    expect(app.text()).not.toContain('2026-10-07');
    expect(app.views).toHaveLength(3);
  });
}
