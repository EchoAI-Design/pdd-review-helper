const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require(process.env.PDD_NODE_MODULES + '/playwright');
const dir = path.resolve(__dirname, '../pdd-review-helper');
let browser;
before(async () => { browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true }); });
after(async () => { await browser?.close(); });
async function fixture(file = 'fixture.html') {
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: fs.readFileSync(path.join(__dirname, file), 'utf8') }));
  await page.goto('https://mms.pinduoduo.com/goods/evaluation/index');
  for (const file of ['core.js', 'adapter.js', 'scanner.js', 'shop.js', 'reporter.js']) await page.addScriptTag({ path: path.join(dir, file) });
  await page.evaluate(() => { window.binding = { shopKey: 'test-shop', name: '模拟运动店铺', selector: '#shop' }; window.adapter = new PddAdapter(binding, { stableFor: 80, poll: 25, timeout: 1000 }); });
  return page;
}
test('DOM adapter performs three rounds, traverses pages and never clicks report', async () => {
  const page = await fixture();
  const result = await page.evaluate(async () => { const task = PddCore.newTask(binding); await new PddScanRunner(adapter, async () => {}).run(task); return { task, actions }; });
  assert.equal(result.task.status, 'completed', result.task.message); assert.equal(result.task.records.length, 4);
  assert.equal(result.task.records.filter(r => r.reportState === 'reported').length, 1);
  assert.equal(result.task.records.filter(r => r.reportState === 'unknown').length, 1);
  assert.equal(result.task.records[0].contentType, 'no_text'); assert.equal(result.actions.filter(a => a === 'query').length, 3);
  assert.ok(result.actions.includes('next')); assert.ok(!result.actions.includes('REPORT_CLICK')); await page.close();
});
test('screenshot wording: 用户评分, red SVG icons and 63 one-star reviews, then 2/3 stars', async () => {
  const page = await fixture('screenshot-fixture.html');
  const result = await page.evaluate(async () => {
    mode = 'ambiguousNext'; render();
    const task = PddCore.newTask(binding); await new PddScanRunner(adapter, async () => {}).run(task);
    return { task, actions };
  });
  assert.equal(result.task.status, 'completed', result.task.message);
  assert.equal(result.task.records.length, 100);
  assert.deepEqual([1, 2, 3].map(s => result.task.countsByStar[s].observed), [63, 25, 12]);
  assert.deepEqual(result.actions.filter(a => a.startsWith('query-')), ['query-1', 'query-2', 'query-3']);
  assert.equal(result.actions.filter(a => a === 'next-1').length, 6);
  assert.ok(!result.actions.includes('JUMP'));
  assert.ok(!result.actions.includes('REPORT_CLICK')); await page.close();
});
test('DOM shop switching is caught before page action', async () => {
  const page = await fixture();
  const error = await page.evaluate(async () => { document.querySelector('#shop').textContent = '其他店铺'; try { await adapter.queryStar(1, async () => {}); } catch (e) { return { code: e.code, actions }; } });
  assert.equal(error.code, 'SHOP_CHANGED'); assert.deepEqual(error.actions, []); await page.close();
});

test('rating counts spaced stars and repeated icon-font glyphs without counting hidden or interaction icons', async () => {
  const page = await fixture('screenshot-fixture.html');
  const result = await page.evaluate(() => {
    const card = adapter.tables()[0], header = card.querySelector('tr');
    const results = [];
    for (const stars of [1, 2, 3, 4, 5]) for (const mode of ['spaced', 'font']) {
      const icons = mode === 'spaced' ? Array.from({ length: stars }, () => '<span>★</span>').join(' ') :
        `<span class="rating-star" style="color:rgb(255,77,79)">${'\ue600'.repeat(stars)}</span>`;
      header.innerHTML = `<td colspan="4">用户评分：${icons}<span style="display:none">★★★★★</span><span>被点赞数：0 互动数：0 ★</span></td>`;
      results.push({ expected: stars, actual: adapter.rating(card), mode });
    }
    return results;
  });
  for (const item of result) assert.equal(item.actual, item.expected, JSON.stringify(item));
  await page.close();
});

for (const markup of ['spaced', 'font']) test(`all selected star rounds finish with ${markup} rating markup`, async () => {
  const page = await fixture('screenshot-fixture.html');
  const result = await page.evaluate(async markup => {
    const original = render;
    window.render = () => {
      original();
      for (const card of adapter.tables()) {
        card.querySelector('tr td').innerHTML = '<span>用户评分：</span>' + (markup === 'spaced' ?
          Array.from({ length: currentStar }, () => '<span>★</span>').join(' ') :
          `<span class="rating-star" style="color:rgb(255,77,79)">${'\ue600'.repeat(currentStar)}</span>`) + '<span>被点赞数：0 互动数：0</span>';
      }
    };
    render();
    const task = PddCore.newTask(binding); await new PddScanRunner(adapter, async () => {}).run(task);
    return { status: task.status, message: task.message, counts: [1, 2, 3].map(star => task.records.filter(r => r.stars === star).length), actions };
  }, markup);
  assert.equal(result.status, 'completed', result.message);
  assert.deepEqual(result.counts, [63, 25, 12]);
  assert.ok(!result.actions.includes('REPORT_CLICK')); await page.close();
});
test('query criteria selects requested stars/date and populates page controls', async () => {
  const page = await fixture('screenshot-fixture.html');
  const result = await page.evaluate(async () => {
    const task = PddCore.newTask(binding);
    task.criteria = PddCore.normalizeCriteria({ date: '近90天', stars: [2], content: ['有图片', '主评有文字'], reply: '未回复', reward: true,
      tag: '质量差', orderId: '260909-20001', productId: '900123', keyword: '模拟' });
    await new PddScanRunner(adapter, async () => {}).run(task);
    return { task, query: lastQuery, actions };
  });
  assert.equal(result.task.status, 'completed', result.task.message);
  assert.equal(result.task.records.length, 1); assert.equal(result.task.records[0].stars, 2);
  assert.equal(result.query.date, '近90天'); assert.deepEqual(result.query.content, ['有图片', '主评有文字']);
  assert.equal(result.query.reply, '未回复'); assert.equal(result.query.reward, true); assert.equal(result.query.tag, '质量差(12)');
  assert.equal(result.query.order, '260909-20001'); assert.equal(result.query.product, '900123'); assert.equal(result.query.keyword, '模拟');
  assert.deepEqual(result.actions.filter(a => a.startsWith('query-')), ['query-2']); await page.close();
});
for (const scenario of ['unverified', 'prepared', 'already-reported', 'disabled-type', 'content-changed']) {
  test('report preparation ' + scenario + ' never submits', async () => {
    const page = await fixture('screenshot-fixture.html');
    const result = await page.evaluate(async scenario => {
      allowReports = true;
      const p = await adapter.queryStar(1, async () => {});
      const record = PddCore.mergeRecords([], [p.rows[0]])[0];
      record.review = { status: scenario === 'unverified' ? 'pending' : 'verified', reason: '评价内容异常',
        facts: '模拟测试中已核验的评价存在无关信息，具体内容与对应截图已保存用于本条复核。', evidence: '模拟截图记录', attested: true };
      if (scenario === 'already-reported') document.querySelector('.report-action').textContent = '已举报';
      if (scenario === 'disabled-type') disabledReason = '评价内容异常';
      if (scenario === 'content-changed') record.content = '不同的评价文本';
      let outcome;
      try { outcome = await new PddReportPreparer(adapter).run(record, PddCore.normalizeCriteria()); }
      catch (e) { outcome = { status: 'error', message: e.message }; }
      return { outcome, actions, facts: document.querySelector('[role="dialog"] textarea')?.value, modal: !!document.querySelector('[role="dialog"]') };
    }, scenario);
    assert.ok(!result.actions.includes('SUBMIT'));
    if (scenario === 'prepared') { assert.equal(result.outcome.status, 'prepared', result.outcome.message); assert.match(result.facts, /模拟测试/); }
    if (scenario === 'already-reported') { assert.equal(result.outcome.status, 'skipped_reported'); assert.ok(!result.actions.includes('REPORT_CLICK')); }
    if (scenario === 'disabled-type') { assert.equal(result.outcome.status, 'skipped_type_disabled'); assert.equal(result.modal, false); }
    if (['unverified', 'content-changed'].includes(scenario)) { assert.equal(result.outcome.status, 'error'); assert.ok(!result.actions.includes('REPORT_CLICK')); }
    await page.close();
  });
}
test('pagination ignores size labels and respects disabled ancestors of next icons', async () => {
  const page = await fixture('screenshot-fixture.html');
  const result = await page.evaluate(() => {
    document.querySelector('.page-next').className = 'page-next PGT_disabled_123';
    document.querySelector('.page-next').innerHTML = '<span class="next-icon">›</span>';
    return (({ page, last }) => ({ page, last }))(adapter.pagination());
  });
  assert.deepEqual(result, { page: 1, last: true }); await page.close();
});
test('DOM unchanged query times out instead of accepting stale rows', async () => {
  const page = await fixture();
  const result = await page.evaluate(async () => {
    await adapter.queryStar(1, async () => {}); mode = 'stuck';
    try { await adapter.queryStar(1, async () => {}); } catch (e) { return e.code; }
  });
  assert.equal(result, 'RESULT_TIMEOUT'); await page.close();
});
test('DOM unknown rating and unidentifiable pagination fail closed', async () => {
  const page = await fixture();
  const result = await page.evaluate(async () => {
    await adapter.queryStar(1, async () => {});
    document.querySelectorAll('[data-rating]').forEach(el => { el.removeAttribute('data-rating'); el.textContent = '未识别图标'; });
    let rating, pagination; try { adapter.readPage(1); } catch (e) { rating = e.message; }
    document.querySelector('.pagination').remove(); try { adapter.pagination(); } catch (e) { pagination = e.message; }
    return { rating, pagination };
  });
  assert.match(result.rating, /星级/); assert.match(result.pagination, /分页/); await page.close();
});
test('DOM diagnostic does not include customer/order/cookie data', async () => {
  const page = await fixture(); const diagnostic = await page.evaluate(() => adapter.diagnostic());
  assert.equal(diagnostic.shopMatches, true); assert.ok(!JSON.stringify(diagnostic).includes('260908-10001')); await page.close();
});
test('automatic shop detection excludes review cards, rejects ambiguous names and retries after login', async () => {
  const page = await fixture();
  assert.equal(await page.evaluate(() => PddShop.detect().name), '模拟运动店铺');
  await page.evaluate(() => { document.querySelector('#shop').innerHTML = '<span>阿莱运动</span>'; });
  assert.equal(await page.evaluate(() => PddShop.detect().name), '阿莱运动');
  await page.evaluate(() => { document.querySelector('#shop').id = 'unknown'; document.querySelector('#unknown').style.cssText = 'position:absolute;right:25px;top:20px'; document.querySelector('#unknown').textContent = '模拟样例店铺'; });
  assert.equal(await page.evaluate(() => PddShop.detect().name), '模拟样例店铺');
  await page.evaluate(() => { document.querySelector('td').textContent = '其他商品旗舰店'; });
  assert.equal(await page.evaluate(() => PddShop.detect().name), '模拟样例店铺');
  await page.evaluate(() => { const other = document.createElement('span'); other.className = 'shop-name'; other.style.cssText = 'position:absolute;top:55px;right:20px'; other.textContent = '第二测试店铺'; document.body.append(other); });
  assert.match(await page.evaluate(() => PddShop.detect().error), /多个/);
  await page.evaluate(() => { document.querySelector('#unknown').remove(); document.querySelector('.shop-name').remove(); });
  assert.match(await page.evaluate(() => PddShop.detect().error), /暂未/);
  await page.close();
});
test('management UI renders and review validation displays errors; screenshot saved', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await page.route('**/*', route => {
    const basename = path.basename(new URL(route.request().url()).pathname);
    const file = path.join(dir, basename);
    if (!fs.existsSync(file)) return route.abort();
    route.fulfill({ path: file, contentType: basename.endsWith('.css') ? 'text/css' : basename.endsWith('.js') ? 'text/javascript' : 'text/html' });
  });
  await page.addInitScript(() => {
    const binding = { shopKey: 'demo', name: '模拟运动店铺', selector: '#shop', tabId: 10 };
    const records = [
      { orderId: '260908-10001', content: '该用户未填写文字评价', contentType: 'no_text', reportState: 'available', stars: 1 },
      { orderId: '260908-10002', content: '做工与预期不符，收到的商品有线头。', contentType: 'text', reportState: 'reported', stars: 1 },
      { orderId: '260908-10003', content: '尺码不合适', contentType: 'text', reportState: 'unknown', stars: 2 },
      { orderId: '260908-30001', content: '包装有些破损，产品使用正常。', contentType: 'text', reportState: 'available', stars: 3 }
    ].map((r, i) => ({ ...r, key: String(i), shopKey: 'demo', productId: '900123', reviewTime: '2026-09-08 12:30:00', review: { status: 'pending' } }));
    const task = { id: 'demo-task', shop: binding, day: '2026-09-10', status: 'completed', completeness: 'complete', records,
      message: '1—3星扫描完成；所有分页数量已核对，未执行举报', events: [{ at: Date.now(), message: '3星核对完成，共1条' }],
      countsByStar: { 1: { observed: 2, expected: 2, complete: true }, 2: { observed: 1, expected: 1, complete: true }, 3: { observed: 1, expected: 1, complete: true } } };
    window.chrome = { storage: { onChanged: { addListener() {} } }, runtime: { async sendMessage(message) {
      if (message.type === 'STATE') return { ok: true, data: { tabs: [{ id: 10, title: '评价管理' }], bindings: { 10: binding }, tasks: [{ id: task.id, name: binding.name, status: task.status }], active: null } };
      if (message.type === 'TASK') return { ok: true, data: task };
      if (message.type === 'REVIEW') { try { task.records.find(r => r.key === message.key).review = PddCore.validateReview(task.records.find(r => r.key === message.key), message.review); return { ok: true, data: task }; } catch (e) { return { ok: false, error: e.message }; } }
      return { ok: true, data: true };
    } } };
  });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('https://helper.test/app.html');
  await page.waitForFunction(() => document.querySelector('#total').textContent === '4');
  await page.screenshot({ path: path.join(__dirname, '../artifacts/界面预览-模拟数据.png'), fullPage: true });
  await page.locator('#rows button').first().click();
  await page.selectOption('#review-status', 'verified'); await page.locator('#save-review').click();
  await page.waitForFunction(() => document.querySelector('#review-error').textContent.includes('原因'));
  await page.selectOption('#reason', '利用评价要挟'); await page.fill('#facts', '该条评价所对应的客服记录已核实，实际发生情况和沟通时间详见备注。');
  await page.fill('#evidence', '客服记录截图第1张'); await page.check('#attested'); await page.locator('#save-review').click();
  await page.waitForFunction(() => !document.querySelector('#open-report').disabled);
  await page.locator('#close-review').click();
  assert.ok((await page.locator('#rows').innerText()).includes('已核验（未提交）'));
  const exported = page.waitForEvent('download'); await page.locator('#summary').click();
  const file = await exported; const exportPath = path.join(__dirname, '../artifacts/店铺汇总-模拟测试.csv'); await file.saveAs(exportPath);
  assert.match(fs.readFileSync(exportPath, 'utf8'), /"查询完成（举报结果待核对）",""/);
  assert.deepEqual(errors, []); await page.close();
});
