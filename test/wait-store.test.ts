import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WaitStore } from '../src/wait-store.js';

test('reply text is returned unchanged and empty replies are refused', async () => {
    const store = new WaitStore();
    const pending = store.waitForResponse({
        sessionId: 's1',
        context: 'Ready to ship.',
        timeoutMs: 5000,
    });
    const waitId = store.listPendingWaits()[0].id;
    assert.deepEqual(store.respond(waitId, '   '), { ok: false, reason: 'empty-message' });
    assert.equal(store.respond(waitId, '  Ship it\nnow  ').ok, true);
    const resolution = await pending;
    assert.deepEqual(resolution, { kind: 'message', text: 'Ship it\nnow' });
    assert.equal(store.listSessionTimeline('s1')[0].userMessage, 'Ship it\nnow');
});

test('timeout, cancel, and interrupt each settle the same wait once', async () => {
    const store = new WaitStore();
    const timed = store.waitForResponse({ sessionId: 's-time', context: 'wait', timeoutMs: 20 });
    assert.deepEqual(await timed, { kind: 'timeout' });

    const canceled = store.waitForResponse({ sessionId: 's-cancel', context: 'wait', timeoutMs: 5000 });
    const cancelId = store.listPendingWaits()[0].id;
    assert.equal(store.cancel(cancelId).ok, true);
    assert.deepEqual(await canceled, { kind: 'canceled' });
    assert.equal(store.cancel(cancelId).ok, false);

    const interrupted = store.waitForResponse({ sessionId: 's-stop', context: 'wait', timeoutMs: 5000 });
    assert.equal(store.interruptSession('s-stop', 'session-closed'), 1);
    assert.deepEqual(await interrupted, { kind: 'interrupted', reason: 'session-closed' });
    assert.equal(store.historyCount(), 3);
    assert.equal(store.interruptAll('shutdown'), 0);
});

test('a closed session does not leave a pending wait', async () => {
    const store = new WaitStore();
    const first = store.waitForResponse({ sessionId: 'agent', context: 'one', timeoutMs: 0 });
    const second = store.waitForResponse({ sessionId: 'agent', context: 'two', timeoutMs: 0 });
    assert.equal(store.interruptSession('agent', 'session-closed'), 2);
    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map((item) => item.kind), ['interrupted', 'interrupted']);
    assert.equal(store.listPendingWaits().length, 0);
});

test('session concurrency cap returns busy without opening another wait', async () => {
    const store = new WaitStore();
    const open = [];
    for (let i = 0; i < 10; i++) {
        open.push(store.waitForResponse({ sessionId: 'burst', context: `c${i}`, timeoutMs: 0 }));
    }
    const busy = await store.waitForResponse({ sessionId: 'burst', context: 'overflow', timeoutMs: 0 });
    assert.equal(busy.kind, 'busy');
    if (busy.kind === 'busy') {
        assert.equal(busy.scope, 'session');
        assert.equal(busy.activeWaitIds.length, 10);
    }
    assert.equal(store.listPendingWaits().length, 10);
    store.interruptAll('shutdown');
    await Promise.all(open);
});
