const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PDD_NODE_MODULES + '/playwright');
let browser;
before(async () => { browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true }); });
after(async () => { await browser?.close(); });
async function fixture() {
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(__dirname, 'screenshot-fixture.html'), 'utf8') }));
  await page.goto('https://mms.pinduoduo.com/goods/evaluation/index');
  for (const file of ['core.js', 'adapter.js', 'reporter.js', 'batch.js']) await page.addScriptTag({ path: path.join(__dirname, '../pdd-review-helper', file) });
  await page.evaluate(async () => {
    allowReports = true; confirmMockReports = true;
    window.binding = { shopKey: 'test-shop', name: '模拟运动店铺', selector: '#shop' };
    window.adapter = new PddAdapter(binding, { stableFor: 30, poll: 15, timeout: 1000 });
    const data = await adapter.queryStar(1, async () => {});
    window.task = PddCore.newTask(binding);
    task.records = PddCore.mergeRecords([], data.rows.slice(0, 3));
    task.records.forEach(row => { row.review = { status: 'verified', reason: '评价内容异常', facts: '本条为自动化测试的模拟核验事实，异常信息已逐项记录并保存对应截图。', evidence: '模拟订单截图证据', attested: true }; });
    task.batch = PddCore.newBatch(task);
    window.fast = { poll: 20, closeGrace: 100, waitTimeout: 1200 };
  });
  return page;
}

test('batch skips reported/disabled records, waits for manual submission, and advances only after exact-card status changes', async () => {
  const page = await fixture();
  const result = await page.evaluate(async () => {
    document.querySelectorAll('.report-action')[0].textContent = '已举报';
    disabledReportKeys = new Set(['1-2']);
    let manualClicks = 0, submitBeforeManual = null;
    const runner = new PddBatchReporter(adapter, async batch => {
      if (batch.status === 'waiting' && manualClicks === 0) {
        submitBeforeManual = actions.filter(a => a === 'SUBMIT').length;
        manualClicks++; setTimeout(() => document.querySelector('[role="dialog"] .submit').click(), 30);
      }
    }, fast);
    await runner.run(task);
    return { batch: task.batch, actions, manualClicks, submitBeforeManual };
  });
  assert.equal(result.batch.status, 'completed', result.batch.message);
  assert.deepEqual(result.batch.items.map(item => item.state), ['skipped_reported', 'skipped_type_disabled', 'confirmed_reported']);
  assert.equal(result.submitBeforeManual, 0); assert.equal(result.manualClicks, 1);
  assert.equal(result.actions.filter(a => a === 'SUBMIT').length, 1);
  assert.equal(result.actions.filter(a => a === 'REPORT_CLICK').length, 2);
  await page.close();
});

test('cancel is not success; resume observes the unresolved card without reopening it', async () => {
  const page = await fixture();
  const result = await page.evaluate(async () => {
    task.batch.items = task.batch.items.slice(0, 2);
    let cancelled = false;
    const first = new PddBatchReporter(adapter, async batch => {
      if (batch.status === 'waiting' && !cancelled) { cancelled = true; setTimeout(() => document.querySelector('[role="dialog"] .cancel').click(), 20); }
    }, fast);
    await first.run(task); const stopped = structuredClone(task.batch);
    const openedBeforeResume = actions.filter(a => a === 'REPORT_CLICK').length;
    // External/manual platform state update, including a fresh render on resume.
    reportedOrders.add('1-1'); render(); disabledReportKeys = new Set(['1-2']);
    await new PddBatchReporter(adapter, async () => {}, fast).run(task);
    return { stopped, batch: task.batch, openedBeforeResume, actions };
  });
  assert.equal(result.stopped.status, 'needs_attention'); assert.equal(result.stopped.cursor, 0);
  assert.equal(result.stopped.items[0].state, 'unconfirmed');
  assert.equal(result.batch.status, 'completed', result.batch.message);
  assert.deepEqual(result.batch.items.map(item => item.state), ['confirmed_reported', 'skipped_type_disabled']);
  assert.equal(result.openedBeforeResume, 1); assert.equal(result.actions.filter(a => a === 'REPORT_CLICK').length, 2);
  assert.ok(!result.actions.includes('SUBMIT')); await page.close();
});

for (const scenario of ['pause', 'skip', 'shop-change', 'storage-failure', 'disabled-close-failure']) test('batch handles ' + scenario + ' without submitting', async () => {
  const page = await fixture();
  const result = await page.evaluate(async scenario => {
    task.batch.items = task.batch.items.slice(0, scenario === 'disabled-close-failure' ? 2 : 1);
    if (scenario === 'disabled-close-failure') {
      disabledReason = '评价内容异常';
      const original = openReport;
      window.openReport = button => { original(button); document.querySelector('[role="dialog"] .cancel').onclick = () => {}; };
    }
    let trigger = false;
    const runner = new PddBatchReporter(adapter, async batch => {
      if (scenario === 'storage-failure') throw new Error('模拟持久化失败');
      if (batch.status === 'waiting' && !trigger) {
        trigger = true;
        if (scenario === 'shop-change') document.querySelector('#shop').textContent = '其他店铺';
        else runner.control(scenario);
      }
    }, fast);
    let error = '';
    try { await runner.run(task); } catch (e) { error = e.message; }
    return { batch: task.batch, actions, running: runner.running, error };
  }, scenario);
  assert.equal(result.running, false); assert.ok(!result.actions.includes('SUBMIT'));
  if (scenario === 'pause') { assert.equal(result.batch.status, 'paused'); assert.equal(result.batch.cursor, 0); }
  if (scenario === 'skip') { assert.equal(result.batch.status, 'completed'); assert.equal(result.batch.items[0].state, 'skipped_manual'); }
  if (scenario === 'shop-change') { assert.equal(result.batch.status, 'needs_attention'); assert.equal(result.batch.cursor, 0); }
  if (scenario === 'storage-failure') { assert.match(result.error, /持久化失败/); assert.ok(!result.actions.includes('REPORT_CLICK')); }
  if (scenario === 'disabled-close-failure') { assert.equal(result.batch.cursor, 0); assert.equal(result.batch.status, 'needs_attention'); assert.equal(result.actions.filter(a => a === 'REPORT_CLICK').length, 1); }
  await page.close();
});

test('batch locates verified records across pages and star filters', async () => {
  const page = await fixture();
  const result = await page.evaluate(async () => {
    const page1 = adapter.readPage(1), page2 = await adapter.next(page1, 1, async () => {});
    const twoStars = await adapter.queryStar(2, async () => {}), review = task.records[0].review;
    task.records = PddCore.mergeRecords([], [page2.rows[0], twoStars.rows[0]]);
    task.records.forEach(row => { row.review = review; }); task.batch = PddCore.newBatch(task);
    const seen = new Set();
    const runner = new PddBatchReporter(adapter, async batch => {
      if (batch.status === 'waiting' && !seen.has(batch.cursor)) {
        seen.add(batch.cursor); setTimeout(() => document.querySelector('[role="dialog"] .submit').click(), 30);
      }
    }, fast);
    await runner.run(task);
    return { batch: task.batch, actions, confirmed: [...reportedOrders] };
  });
  assert.equal(result.batch.status, 'completed', result.batch.message);
  assert.deepEqual(result.batch.items.map(item => item.state), ['confirmed_reported', 'confirmed_reported']);
  assert.ok(result.actions.includes('next-1')); assert.deepEqual(result.confirmed, ['1-11', '2-1']);
  await page.close();
});
