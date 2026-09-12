const { test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../pdd-review-helper/core.js');
const Runner = require('../pdd-review-helper/scanner.js');
const binding = { shopKey: 'shop-a', name: '测试店铺', selector: '#shop' };
const row = (id, stars = 1, extras = {}) => ({ shopKey: binding.shopKey, orderId: String(id), productId: '9001',
  reviewTime: '2026-09-01 12:30:00', stars, content: '该用户未填写文字评价', contentType: 'no_text', reportState: 'available', ...extras });
const page = (rows, total, number = 1, last = true) => ({ rows, total, page: number, last,
  signature: JSON.stringify([total, number, rows]) });
function adapter(pages) {
  return { assertShop() {}, async queryStar(star) { return pages[star]?.[0] || page([], 0); },
    async next(current, star) { return pages[star][current.page]; } };
}
test('report status: explicit reported, enabled report, missing and disabled are distinct', () => {
  assert.equal(C.reportState('查看订单 已举报 回复', true), 'reported');
  assert.equal(C.reportState('查看订单 举报 回复', true), 'available');
  assert.equal(C.reportState('查看订单 举报 回复', false), 'unknown');
  assert.equal(C.reportState('查看订单 回复', false), 'unknown');
});
test('query defaults to last30 days and 1/2/3 stars, rejects empty star selection', () => {
  assert.equal(C.normalizeCriteria().date, '近30天'); assert.deepEqual(C.normalizeCriteria().stars, [1, 2, 3]);
  assert.throws(() => C.normalizeCriteria({ stars: [] }), /至少/);
  assert.throws(() => C.normalizeCriteria({ stars: [6] }), /有效星级/);
  assert.throws(() => C.normalizeCriteria({ content: ['未知条件'] }), /无效/);
});
test('dedupe, shop isolation, changed content conflict, review note retention', () => {
  let records = C.mergeRecords([], [row(1), row(1), row(1, 1, { shopKey: 'shop-b' })]);
  assert.equal(records.length, 2);
  records[0].review.facts = '已人工核实的备注';
  records = C.mergeRecords(records, [row(1)]);
  assert.equal(records[0].review.facts, '已人工核实的备注');
  records = C.mergeRecords(records, [row(1, 1, { content: '内容发生变化' })]);
  assert.equal(records[0].conflict, true);
  assert.equal(records[0].content, '该用户未填写文字评价');
});
test('CSV formulas are inert and quotes/newlines preserved', () => {
  assert.equal(C.csvCell('=1+1'), '"\'=1+1"');
  assert.equal(C.csvCell(' @SUM(A1)'), '"\' @SUM(A1)"');
  assert.equal(C.csvCell('他说"差"\n下一行'), '"他说""差""\n下一行"');
  assert.ok(C.csv([['你好']]).startsWith('\uFEFF'));
});
test('verified evidence requires facts, corresponding evidence and attestation', () => {
  const review = { status: 'verified', reason: '利用评价要挟', facts: '客服已核实该条评价对应的沟通记录和提出要求的具体时间。', evidence: '', attested: true };
  assert.throws(() => C.validateReview(row(1), review), /证据/);
  review.evidence = '客服记录第3张截图'; review.attested = false;
  assert.throws(() => C.validateReview(row(1), review), /确认/);
  review.attested = true;
  assert.equal(C.validateReview(row(1), review).status, 'verified');
  assert.throws(() => C.validateReview(row(1, 1, { reportState: 'reported' }), review), /入口/);
  assert.throws(() => C.validateReview(row(1, 1, { conflict: true }), review), /冲突/);
});
test('three-star rounds, multiple pages, empty results and zero submission count', async () => {
  const saves = [], task = C.newTask(binding);
  const runner = new Runner(adapter({ 1: [page([row(1), row(2)], 3, 1, false), page([row(3)], 3, 2)],
    3: [page([row(4, 3)], 1)] }), async task => saves.push(structuredClone(task)));
  await runner.run(task);
  assert.equal(task.status, 'completed'); assert.equal(task.records.length, 4);
  assert.deepEqual(task.completedStars, [1, 2, 3]); assert.equal(task.submittedCount, 0);
  assert.ok(saves.some(t => t.currentPage === 2));
});
test('pause and resume restart from first page, preserve notes and deduplicate', async () => {
  const a = adapter({ 1: [page([row(1)], 2, 1, false), page([row(2)], 2, 2)] });
  let shouldPause = true;
  const task = C.newTask(binding), runner = new Runner(a, async t => {
    if (shouldPause && t.currentPage === 1) { shouldPause = false; runner.control('pause'); }
  });
  await runner.run(task); assert.equal(task.status, 'paused'); assert.equal(task.records.length, 1);
  task.records[0].review.facts = '保留备注';
  await runner.run(task); assert.equal(task.status, 'completed'); assert.equal(task.records.length, 2);
  assert.equal(task.records[0].review.facts, '保留备注'); assert.equal(task.attempt, 2);
});
for (const [name, pages, pattern] of [
  ['duplicate rows on later page', { 1: [page([row(1)], 2, 1, false), page([row(1)], 2, 2)] }, /重复/],
  ['missing rows on last page', { 1: [page([row(1)], 2)] }, /只获取/],
  ['total changes while paging', { 1: [page([row(1)], 2, 1, false), page([row(2)], 3, 2)] }, /总数/],
  ['display cap', { 1: [page([row(1)], 2000)] }, /2000/],
  ['wrong shop', { 1: [page([row(1, 1, { shopKey: 'other' })], 1)] }, /店铺/],
  ['wrong rating', { 1: [page([row(1, 5)], 1)] }, /星级/]
]) test(name + ' never marked complete', async () => {
  const task = C.newTask(binding); await new Runner(adapter(pages), async () => {}).run(task);
  assert.equal(task.status, 'needs_attention'); assert.equal(task.completeness, 'incomplete'); assert.match(task.message, pattern);
});
test('stale records retained but excluded from current totals and labeled in export', async () => {
  const task = C.newTask(binding); task.records = C.mergeRecords([], [row(99)]);
  await new Runner(adapter({}), async () => {}).run(task);
  assert.equal(task.records.length, 1); assert.equal(C.stats(task).total, 0);
  assert.match(C.exportCsv(task), /历史记录（本轮未发现）/);
});
test('day rollover stops resume', async () => {
  const task = C.newTask(binding); task.day = '2000-01-01';
  await new Runner(adapter({}), async () => {}).run(task);
  assert.equal(task.errorCode, 'DAY_CHANGED'); assert.equal(task.status, 'needs_attention');
});
test('storage failures stop executor', async () => {
  const runner = new Runner(adapter({}), async () => { throw new Error('storage quota'); });
  await assert.rejects(runner.run(C.newTask(binding)), /storage quota/); assert.equal(runner.running, false);
});
test('account mapping strips credentials and requires unique exact shop name before selecting a row', () => {
  const map = C.normalizeAccountMap({ format: 'pdd-account-map-v1', source: 'accounts.xlsx', sheet: 'Sheet1', password: 'do-not-keep', rows: [
    { name: '模拟店铺', row: 2, account: 'do-not-keep', password: 'do-not-keep' }, { name: '同名店铺', row: 3 }, { name: '同名店铺', row: 4 }
  ] });
  assert.equal(JSON.stringify(map).includes('do-not-keep'), false);
  assert.equal(C.matchAccount(map, '模拟店铺').row, 2);
  assert.equal(C.matchAccount(map, '同名店铺').status, 'ambiguous');
  assert.equal(C.matchAccount(map, '模拟').status, 'unmatched');
  assert.throws(() => C.normalizeAccountMap({ ...map, rows: [{ name: 'a', row: 2 }, { name: 'b', row: 2 }] }));
});
test('batch candidates require verified facts/evidence and exclude historical, reported, conflicted or duplicate rows', () => {
  const task = C.newTask(binding);
  const good = C.mergeRecords([], [row('1')])[0];
  good.review = { status: 'verified', reason: '评价内容异常', facts: '本测试条目的事实已逐项核实，截图和原始沟通内容已对应保留。', evidence: '模拟截图文件', attested: true };
  task.records = [good, good, { ...good, key: 'reported', reportState: 'reported' }, { ...good, key: 'conflict', conflict: true },
    { ...good, key: 'history', inCurrentScope: false }, { ...good, key: 'no-evidence', review: { ...good.review, evidence: '' } },
    { ...good, key: 'pending', review: { ...good.review, status: 'pending' } }];
  assert.deepEqual(C.batchCandidates(task).map(r => r.key), [good.key]);
  task.batch = C.newBatch(task); assert.equal(task.batch.items.length, 1);
  assert.equal(C.batchStats(task.batch).confirmed, 0);
  const old = { ...good, reportBatchResult: { status: 'skipped_manual' } };
  assert.equal(C.mergeRecords([old], [row('1')])[0].reportBatchResult.status, 'skipped_manual');
  task.batch.items[0].state = 'confirmed_reported';
  assert.match(C.exportBatchCsv(task), /已确认平台显示已举报/);
});
