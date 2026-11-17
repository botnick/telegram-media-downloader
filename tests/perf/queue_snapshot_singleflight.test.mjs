// Run: node --test tests/perf/queue_snapshot_singleflight.test.mjs
// Exercise the actual loadSnapshot() implementation extracted from queue.js.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(
  new URL('../../core-service/internal/webassets/public/js/queue.js', import.meta.url), 'utf8',
);
const start = source.indexOf('let _snapshotInFlight = null;');
const end = source.indexOf('async function fetchAndApplySnapshot()', start);
assert.ok(start >= 0 && end > start, 'snapshot coalescing functions must exist');
const extracted = source.slice(start, end);

test('simultaneous snapshot loads share a request and retry after settlement', async () => {
  let calls = 0;
  let resolve;
  const context = vm.createContext({
    fetchAndApplySnapshot: () => {
      calls++;
      return new Promise((done) => { resolve = done; });
    },
  });
  vm.runInContext(extracted, context);
  const first = vm.runInContext('loadSnapshot()', context);
  const second = vm.runInContext('loadSnapshot()', context);
  assert.equal(first, second);
  assert.equal(calls, 1);
  resolve();
  await first;
  await Promise.resolve(); // in-flight clearing microtask
  const third = vm.runInContext('loadSnapshot()', context);
  assert.notEqual(third, first);
  assert.equal(calls, 2);
  resolve();
  await third;
});

test('failed in-flight snapshot can be retried', async () => {
  let calls = 0;
  let reject;
  const context = vm.createContext({
    fetchAndApplySnapshot: () => {
      calls++;
      return new Promise((_, fail) => { reject = fail; });
    },
  });
  vm.runInContext(extracted, context);
  const first = vm.runInContext('loadSnapshot()', context);
  assert.equal(vm.runInContext('loadSnapshot()', context), first);
  reject(new Error('offline'));
  await assert.rejects(first, /offline/);
  await Promise.resolve();
  const retry = vm.runInContext('loadSnapshot()', context);
  assert.notEqual(retry, first);
  assert.equal(calls, 2);
  reject(new Error('offline'));
  await assert.rejects(retry, /offline/);
});
