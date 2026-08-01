import { describe, expect, it } from 'vitest';

import { OrderedHookSlot } from '#/hooks';

describe('OrderedHookSlot priority', () => {
  it('runs higher priorities first and preserves registration order for ties', async () => {
    const slot = new OrderedHookSlot<{ trace: string[] }>();
    slot.register('ordinary-a', async (context, next) => {
      context.trace.push('ordinary-a');
      await next();
    });
    slot.register('last', async (context, next) => {
      context.trace.push('last');
      await next();
    }, { priority: -100 });
    slot.register('first', async (context, next) => {
      context.trace.push('first');
      await next();
    }, { priority: 100 });
    slot.register('ordinary-b', async (context, next) => {
      context.trace.push('ordinary-b');
      await next();
    });

    const context = { trace: [] as string[] };
    await slot.run(context);
    expect(context.trace).toEqual(['first', 'ordinary-a', 'ordinary-b', 'last']);
  });

  it('lets explicit before and after placement override priority sorting', async () => {
    const slot = new OrderedHookSlot<{ trace: string[] }>();
    slot.register('a', async (context, next) => {
      context.trace.push('a');
      await next();
    });
    slot.register('c', async (context, next) => {
      context.trace.push('c');
      await next();
    });
    slot.register('b', async (context, next) => {
      context.trace.push('b');
      await next();
    }, { before: 'c', priority: -10_000 });

    const context = { trace: [] as string[] };
    await slot.run(context);
    expect(context.trace).toEqual(['a', 'b', 'c']);
  });

  it('does not disturb explicit placement when a priority hook is registered later', async () => {
    const slot = new OrderedHookSlot<{ trace: string[] }>();
    slot.register('a', async (context, next) => {
      context.trace.push('a');
      await next();
    });
    slot.register('c', async (context, next) => {
      context.trace.push('c');
      await next();
    });
    slot.register('b', async (context, next) => {
      context.trace.push('b');
      await next();
    }, { before: 'c', priority: -10_000 });
    slot.register('first', async (context, next) => {
      context.trace.push('first');
      await next();
    }, { priority: 100 });
    slot.register('last', async (context, next) => {
      context.trace.push('last');
      await next();
    }, { priority: -20_000 });

    const context = { trace: [] as string[] };
    await slot.run(context);
    expect(context.trace).toEqual(['first', 'a', 'b', 'c', 'last']);
  });

  it('rejects non-finite priorities', () => {
    const slot = new OrderedHookSlot<object>();
    expect(() => slot.register('bad', async (_context, next) => next(), {
      priority: Number.NaN,
    })).toThrow('finite');
  });
});
