const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PDD_NODE_MODULES + '/playwright');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function panelFrame(page) {
  for (let i = 0; i < 150; i++) {
    const frame = page.frames().find(f => f.url().includes('/app.html?panel=1'));
    if (frame) { await frame.waitForFunction(() => !!document.querySelector('#start')); return frame; }
    await sleep(100);
  }
  throw new Error('左侧面板没有加载');
}
test('MV3 left panel: automatic shop, homepage navigation, scanning, pause/reload/resume, store switch and collapse', { timeout: 90000 }, async () => {
  const extensionDir = path.resolve(__dirname, '../pdd-review-helper');
  const profiles = path.resolve(__dirname, '../artifacts/test-profiles'); fs.mkdirSync(profiles, { recursive: true });
  const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(profiles, 'edge-')), {
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true,
    viewport: { width: 1440, height: 1100 },
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
    const fixture = fs.readFileSync(path.join(__dirname, 'screenshot-fixture.html'), 'utf8');
    await context.route('https://mms.pinduoduo.com/**', route => route.fulfill({ contentType: 'text/html', body: fixture }));
    const merchant = await context.newPage(); await merchant.goto('https://mms.pinduoduo.com/home');
    let app = await panelFrame(merchant);
    await app.waitForFunction(() => document.querySelector('#binding').textContent === '模拟运动店铺');
    assert.equal(await app.locator('#start').textContent(), '进入评价管理');
    await app.locator('#account-file').setInputFiles({ name: 'mock-account-map.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({
      format: 'pdd-account-map-v1', source: '模拟账号表.xlsx', sheet: 'Sheet1', rows: [{ name: '模拟运动店铺', row: 7, password: 'must-not-store' }]
    })) });
    await app.waitForFunction(() => document.querySelector('#account-match').textContent.includes('第7行'));
    assert.equal(JSON.stringify(await worker.evaluate(async () => chrome.storage.local.get('accountMap'))).includes('must-not-store'), false);
    assert.equal(await app.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const pageCount = context.pages().length;
    await app.locator('#start').click();
    await merchant.waitForURL('**/goods/evaluation/index');
    app = await panelFrame(merchant);
    await app.waitForFunction(() => document.querySelector('#start').textContent === '查询' && !document.querySelector('#start').disabled);
    assert.equal(await app.locator('#query-date').inputValue(), '近30天');
    assert.deepEqual(await app.locator('[name="query-star"]:checked').evaluateAll(els => els.map(el => el.value)), ['1', '2', '3']);
    await app.locator('#query-fields').screenshot({ path: path.resolve(__dirname, '../artifacts/查询条件-v0.4.0-模拟数据.png') });
    assert.equal(context.pages().length, pageCount, 'No separate management tab opened');
    await app.locator('#start').click();
    await app.waitForFunction(() => document.querySelector('#status').textContent === '扫描完成');
    assert.equal(await app.locator('#total').textContent(), '100');
    assert.ok(!(await merchant.evaluate(() => actions)).includes('REPORT_CLICK'));
    await merchant.screenshot({ path: path.resolve(__dirname, '../artifacts/左侧面板预览-v0.4.0-模拟数据.png') });
    const stored = await worker.evaluate(async () => chrome.storage.local.get(null));
    const taskKey = Object.keys(stored).find(k => k.startsWith('task:'));
    assert.equal(stored[taskKey].shop.source, 'auto'); assert.equal(stored.active, undefined);
    await merchant.evaluate(() => { window.allowReports = true; });
    await app.locator('#rows button').first().click();
    await app.selectOption('#review-status', 'verified'); await app.selectOption('#reason', '评价内容异常');
    await app.fill('#facts', '模拟集成测试中的单条评价已逐项核实，相关异常内容和截图已经记录。');
    await app.check('#attested'); await app.locator('#save-review').click();
    await app.waitForFunction(() => !document.querySelector('#open-report').disabled);
    await app.locator('#open-report').click();
    await merchant.waitForFunction(() => document.querySelector('[role="dialog"] textarea')?.value.includes('模拟集成测试'));
    assert.ok(!(await merchant.evaluate(() => actions)).includes('SUBMIT'));
    await merchant.locator('[role="dialog"] .cancel').click();
    await app.waitForFunction(() => !document.querySelector('#resume').disabled);
    await merchant.evaluate(() => { queryDelay = 1200; }); await app.locator('#resume').click();
    await app.waitForFunction(async () => {
      const data = await chrome.storage.local.get(null), task = Object.entries(data).find(([key]) => key.startsWith('task:'))?.[1];
      return task?.attempt === 2 && task.status === 'running' && task.currentPage >= 1;
    });
    await app.locator('#pause').click(); await app.waitForFunction(() => document.querySelector('#status').textContent === '已暂停');
    await merchant.reload(); app = await panelFrame(merchant);
    await app.waitForFunction(() => !document.querySelector('#resume').disabled); await app.locator('#resume').click();
    await app.waitForFunction(async () => {
      const data = await chrome.storage.local.get(null), task = Object.entries(data).find(([key]) => key.startsWith('task:'))?.[1];
      return task?.attempt === 3 && task.status === 'completed';
    });
    assert.equal(await app.locator('#total').textContent(), '100');
    await merchant.evaluate(() => document.querySelector('#shop').textContent = '另一店铺');
    await app.waitForFunction(() => document.querySelector('#binding').textContent === '另一店铺');
    assert.match(await app.locator('#account-match').textContent(), /未匹配/);
    assert.equal(await app.locator('#resume').isDisabled(), true);
    const after = await worker.evaluate(async () => chrome.storage.local.get(null));
    assert.equal(after[taskKey].submittedCount, 0);
    const unauthorized = await worker.evaluate(async () => dispatch({ type: 'STATE' }, { id: chrome.runtime.id, url: 'https://mms.pinduoduo.com/home', frameId: 0, tab: { id: 123 } }).catch(e => e.message));
    assert.match(unauthorized, /管理命令/);
    await app.locator('#close-panel').click();
    await merchant.waitForFunction(() => document.querySelector('[data-pdd-helper="panel"]').getBoundingClientRect().width === 34);
    await merchant.reload();
    await merchant.waitForFunction(() => document.querySelector('[data-pdd-helper="panel"]')?.getBoundingClientRect().width === 34);
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://mms.pinduoduo.com/*' }))[0].id);
    await worker.evaluate(async tabId => { await ensureContent(tabId); await chrome.tabs.sendMessage(tabId, { type: 'PDD_PANEL', open: true }, { frameId: 0 }); }, tabId);
    app = await panelFrame(merchant); await app.waitForFunction(() => document.querySelector('#binding').textContent === '模拟运动店铺');
  } finally { await context.close(); }
});
test('missing receiving end: inject into an existing merchant page without reload', { timeout: 40000 }, async () => {
  const artifacts = path.resolve(__dirname, '../artifacts/test-profiles'); fs.mkdirSync(artifacts, { recursive: true });
  const root = fs.mkdtempSync(path.join(artifacts, 'reconnect-')), copy = path.join(root, 'extension'); fs.mkdirSync(copy);
  const source = path.resolve(__dirname, '../pdd-review-helper');
  for (const name of fs.readdirSync(source)) if (fs.statSync(path.join(source, name)).isFile()) fs.copyFileSync(path.join(source, name), path.join(copy, name));
  // Omit automatic injection only in this test copy to reproduce a pre-install open tab.
  const manifest = JSON.parse(fs.readFileSync(path.join(copy, 'manifest.json'), 'utf8')); delete manifest.content_scripts;
  fs.writeFileSync(path.join(copy, 'manifest.json'), JSON.stringify(manifest));
  const context = await chromium.launchPersistentContext(path.join(root, 'profile'), {
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true,
    args: [`--disable-extensions-except=${copy}`, `--load-extension=${copy}`]
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
    await context.route('https://mms.pinduoduo.com/**', route => route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8') }));
    const merchant = await context.newPage(); await merchant.goto('https://mms.pinduoduo.com/home');
    await merchant.evaluate(() => { window.testUnsavedMarker = 'keep-this-page'; });
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({ url: 'https://mms.pinduoduo.com/*' }))[0].id);
    const missing = await worker.evaluate(async id => chrome.tabs.sendMessage(id, { type: 'PDD_PING' }).catch(e => e.message), tabId);
    assert.match(missing, /Receiving end does not exist/);
    await worker.evaluate(async id => ensureContent(id), tabId);
    const app = await panelFrame(merchant);
    await app.waitForFunction(() => document.querySelector('#binding').textContent === '模拟运动店铺');
    assert.equal(await merchant.evaluate(() => testUnsavedMarker), 'keep-this-page');
    const ping = await worker.evaluate(async id => chrome.tabs.sendMessage(id, { type: 'PDD_PING' }, { frameId: 0 }), tabId);
    assert.equal(ping.version, '0.4.0');
  } finally { await context.close(); }
});
test('MV3 batch toolbar: one entry, reload recovery without reopening, manual platform submission and result export', { timeout: 60000 }, async () => {
  const extensionDir = path.resolve(__dirname, '../pdd-review-helper');
  const profiles = path.resolve(__dirname, '../artifacts/test-profiles'); fs.mkdirSync(profiles, { recursive: true });
  const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(profiles, 'batch-')), {
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true,
    viewport: { width: 1440, height: 1100 }, args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`]
  });
  try {
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await context.route('https://mms.pinduoduo.com/**', route => route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(__dirname, 'screenshot-fixture.html'), 'utf8') }));
    const merchant = await context.newPage(); await merchant.goto('https://mms.pinduoduo.com/goods/evaluation/index');
    let app = await panelFrame(merchant);
    await app.waitForFunction(() => document.querySelector('#binding').textContent === '模拟运动店铺');
    const taskId = await worker.evaluate(async () => {
      const tab = (await chrome.tabs.query({ url: 'https://mms.pinduoduo.com/*' }))[0];
      const binding = await detectBinding(tab.id), task = C.newTask(binding);
      task.status = 'completed'; task.completeness = 'complete';
      task.records = C.mergeRecords([], [1, 2].map(n => ({ shopKey: binding.shopKey, orderId: `260909-1000${n}`, productId: '900123',
        reviewTime: '2026-09-09 12:30:00', stars: 1, content: `模拟评价内容 1-${n}`, contentType: 'text', reportState: 'available' })));
      task.records.forEach(row => { row.review = { status: 'verified', reason: '评价内容异常', facts: '本条为模拟集成测试中的已核验事实，相关截图与订单内容已经逐项对应保存。', evidence: '模拟证据截图文件', attested: true }; });
      await saveTask(task); return task.id;
    });
    await merchant.evaluate(() => { allowReports = true; confirmMockReports = true; });
    await app.waitForFunction(() => document.querySelector('#batch-report').textContent.includes('2条') && !document.querySelector('#batch-report').disabled);
    await app.locator('.batch-toolbar').screenshot({ path: path.resolve(__dirname, '../artifacts/批量举报按钮-v0.4.0-模拟数据.png') });
    await app.locator('#batch-report').click();
    await merchant.waitForFunction(() => document.querySelector('[role="dialog"] textarea')?.value.includes('模拟集成测试'));
    await app.waitForFunction(() => !document.querySelector('#batch-skip').disabled);
    assert.ok(!(await merchant.evaluate(() => actions)).includes('SUBMIT'));
    assert.equal(await app.locator('#start').isDisabled(), true, 'Scanning must not interrupt a waiting batch');
    // Simulate page interruption and a platform status already changed externally.
    await merchant.reload(); app = await panelFrame(merchant);
    await merchant.evaluate(() => { allowReports = true; confirmMockReports = true; reportedOrders.add('1-1'); render(); });
    await app.waitForFunction(() => !document.querySelector('#batch-resume').disabled);
    await app.locator('#batch-resume').click();
    await merchant.waitForFunction(() => document.querySelector('[role="dialog"] textarea')?.value.includes('模拟集成测试'));
    assert.equal((await merchant.evaluate(() => actions)).filter(a => a === 'REPORT_CLICK').length, 1, 'Only second record reopened after reload');
    assert.ok(!(await merchant.evaluate(() => actions)).includes('SUBMIT'));
    await merchant.locator('[role="dialog"] .submit').click();
    await app.waitForFunction(() => document.querySelector('#batch-progress').textContent.includes('批量队列处理结束'));
    const stored = await worker.evaluate(async id => (await chrome.storage.local.get('task:' + id))['task:' + id], taskId);
    assert.equal(stored.batch.status, 'completed');
    assert.deepEqual(stored.batch.items.map(item => item.state), ['confirmed_reported', 'confirmed_reported']);
    assert.equal(stored.submittedCount, 0, 'Observed status is not an automatic-submission count');
    const download = app.page().waitForEvent('download'); await app.locator('#batch-export').click();
    const exported = await download; const csv = fs.readFileSync(await exported.path(), 'utf8');
    assert.match(csv, /已确认平台显示已举报/); assert.match(csv, /260909-10001/);
  } finally { await context.close(); }
});
