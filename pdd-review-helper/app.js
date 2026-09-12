(() => {
  'use strict';
  const C = PddCore, $ = id => document.getElementById(id);
  const params = new URL(location.href).searchParams, embedded = params.get('panel') === '1';
  if (embedded) document.body.classList.add('panel');
  let state = { tabs: [], tasks: [], bindings: {} }, task = null, taskId = '', page = 1, reviewKey = '', reviewTaskId = '', timer;
  let refreshing = false, refreshAgain = false, picking = false;
  let criteriaDirty = false;
  function readCriteria() {
    return C.normalizeCriteria({ date: $('query-date').value, stars: [...document.querySelectorAll('[name="query-star"]:checked')].map(el => Number(el.value)),
      content: [...document.querySelectorAll('[name="query-content"]:checked')].map(el => el.value), reply: $('query-reply').value,
      reward: $('query-reward').checked, tag: $('query-tag').value, orderId: $('query-order').value, productId: $('query-product').value, keyword: $('query-keyword').value });
  }
  function writeCriteria(input) {
    const q = C.normalizeCriteria(input);
    $('query-date').value = q.date;
    document.querySelectorAll('[name="query-star"]').forEach(el => { el.checked = q.stars.includes(Number(el.value)); });
    document.querySelectorAll('[name="query-content"]').forEach(el => { el.checked = q.content.includes(el.value); });
    $('query-reply').value = q.reply; $('query-reward').checked = q.reward;
    if (q.tag && ![...$('query-tag').options].some(o => o.value === q.tag)) $('query-tag').append(option(q.tag, q.tag));
    $('query-tag').value = q.tag; $('query-order').value = q.orderId; $('query-product').value = q.productId; $('query-keyword').value = q.keyword;
  }
  const statusLabels = { ready: '待开始', running: '扫描中', paused: '已暂停', stopped: '已停止', completed: '扫描完成', needs_attention: '需要检查' };
  const preferredTab = Number(new URL(location.href).searchParams.get('tab'));
  async function api(type, data = {}) {
    const reply = await chrome.runtime.sendMessage({ type, cap: params.get('cap'), ...data });
    if (!reply?.ok) throw new Error(reply?.error || '插件连接失败');
    return reply.data;
  }
  function notice(message, error = false) { $('notice').textContent = message; $('notice').className = error ? 'error' : ''; $('notice').hidden = false; }
  function option(value, text) { const el = document.createElement('option'); el.value = value; el.textContent = text; return el; }
  function badge(text, type = '') { const el = document.createElement('span'); el.className = 'pill ' + type; el.textContent = text; return el; }
  const stamp = ms => new Date(ms).toLocaleString('zh-CN', { hour12: false });
  function download(name, text, mime) {
    const url = URL.createObjectURL(new Blob([text], { type: mime }));
    const link = document.createElement('a'); link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }
  const filename = suffix => `${(task?.shop.name || '店铺').replace(/[\\/:*?"<>|]/g, '_')}-${task?.day || C.chinaDay(Date.now())}-${suffix}`;
  async function refresh() {
    if (refreshing) { refreshAgain = true; return; }
    refreshing = true;
    try {
    const selectedTab = Number($('tab').value) || preferredTab;
    state = await api('STATE', { tabId: selectedTab });
    $('tab').replaceChildren(...state.tabs.map(t => option(t.id, t.title || `商家页面 ${t.id}`)));
    if (!state.tabs.length) $('tab').append(option('', '请在此浏览器打开商家后台'));
    if (state.tabs.some(t => t.id === selectedTab)) $('tab').value = selectedTab;
    taskId = state.tasks.some(t => t.id === taskId) ? taskId : state.tasks.find(t => t.id === state.active?.taskId)?.id || state.tasks[0]?.id || '';
    $('tasks').replaceChildren(...state.tasks.map(t => option(t.id, `${t.name} · ${statusLabels[t.status] || t.status}`)));
    if (!state.tasks.length) $('tasks').append(option('', '暂无任务'));
    $('tasks').value = taskId;
    task = taskId ? await api('TASK', { id: taskId }) : null;
    render();
    } finally {
      refreshing = false;
      if (refreshAgain) { refreshAgain = false; setTimeout(() => refresh().catch(e => notice(e.message, true)), 50); }
    }
  }
  function render() {
    const tabId = Number($('tab').value), binding = state.bindings[tabId], running = !!state.active;
    const evaluationPage = state.tabs.find(t => t.id === tabId)?.url?.includes('/goods/evaluation/');
    $('binding').textContent = binding ? binding.name : '等待识别当前店铺';
    const match = C.matchAccount(state.accountMap, binding?.name || '');
    $('account-match').textContent = match.status === 'matched' ? `账号表：${match.sheet} 第${match.row}行 · D/E待平台结果核对` :
      match.status === 'ambiguous' ? '账号表有同名店铺，无法唯一确定行号' : match.status === 'unmatched' ? '当前店铺未匹配账号表名称' : '尚未导入账号表行号映射';
    $('import-accounts').disabled = running;
    $('detection').textContent = state.detectionError || (binding ? `${binding.source === 'manual' ? '手动选择已核对' : '已自动识别'} · 当前页面登录店铺` : '打开已登录的商家页面后自动识别');
    $('shop-title').textContent = task ? task.shop.name : binding?.name || '正在连接当前店铺';
    const applied = C.normalizeCriteria(task?.criteria);
    $('query-subtitle').textContent = `${task ? '' : '默认'}${applied.date} · ${applied.stars.join(' / ')} 星 · 自动翻页`;
    $('status').textContent = statusLabels[task?.status] || '待开始';
    if (state.active?.kind === 'report' && state.active.taskId === task?.id) $('status').textContent = '定位举报中';
    if (state.active?.kind === 'batch' && state.active.taskId === task?.id) $('status').textContent = task.batch?.status === 'waiting' ? '等待平台提交' : '批量处理中';
    $('status').className = 'pill ' + (task?.status === 'completed' ? 'good' : task?.status === 'running' ? 'blue' : '');
    $('progress').textContent = task?.message || (evaluationPage ? '店铺识别成功后，即可扫描近30天的1—3星评价。' : '点击下方按钮进入评价管理，面板会继续显示在左侧。');
    $('start').textContent = evaluationPage ? '查询' : '进入评价管理';
    $('start').disabled = running || !tabId || (evaluationPage && !binding);
    $('resume').disabled = running || criteriaDirty || !evaluationPage || !task || task.shop.shopKey !== binding?.shopKey || task.day !== C.chinaDay(Date.now());
    $('query-fields').disabled = running;
    const tagValue = $('query-tag').value, options = state.filterOptions?.tags || [];
    $('query-tag').replaceChildren(option('', '不限标签'), ...options.map(t => option(t.value, t.label)));
    if (tagValue && !options.some(t => t.value === tagValue)) $('query-tag').append(option(tagValue, tagValue));
    $('query-tag').value = tagValue;
    $('pause').disabled = !running || (embedded && state.active.tabId !== tabId); $('stop').disabled = $('pause').disabled; $('bind').disabled = running || !tabId || picking;
    $('diagnostic').disabled = !tabId;
    for (const id of ['csv', 'json', 'summary', 'delete']) $(id).disabled = !task || (id === 'delete' && running);
    const stats = C.stats(task);
    const candidates = C.batchCandidates(task), batch = task?.batch, batchStats = C.batchStats(batch);
    const unfinishedBatch = batch && batch.status !== 'completed' && batch.cursor < batch.items.length;
    const sameShop = !!task && task.shop.shopKey === binding?.shopKey && task.day === C.chinaDay(Date.now());
    $('batch-report').textContent = `批量举报已核验评价（${candidates.length}条）`;
    $('batch-report').disabled = running || !evaluationPage || !sameShop || !candidates.length || !!unfinishedBatch;
    $('batch-resume').disabled = running || !evaluationPage || !sameShop || !unfinishedBatch;
    $('batch-skip').disabled = state.active?.kind !== 'batch' || state.active.taskId !== task?.id || batch?.status !== 'waiting';
    $('batch-export').disabled = !batch;
    $('batch-progress').textContent = batch ? `${batchStats.done}/${batchStats.total}条已处理 · 平台显示已举报${batchStats.confirmed} · 跳过${batchStats.skipped} · 待核对${batchStats.unresolved}。${batch.message}` :
      candidates.length ? `有${candidates.length}条可处理，按当前任务全部已采集记录计算。` : '暂无可处理记录：请先保存“已核验”、具体事实、证据说明和核实确认。';
    $('total').textContent = stats.total; $('reported').textContent = stats.reported;
    $('available').textContent = stats.available; $('uncertain').textContent = `${stats.unknown} / ${stats.conflicts}`;
    $('submitted').textContent = '平台确认的举报数：尚未接入 · 打开或填写表单不计数';
    $('star-progress').replaceChildren(...(task?.criteria?.stars || [1, 2, 3]).map(star => {
      const el = document.createElement('span'), count = task?.countsByStar[star];
      el.textContent = `${star}星 · ${count ? `${count.observed}/${count.expected} 条${count.complete ? ' ✓' : ''}` : '待扫描'}`; return el;
    }));
    $('logs').replaceChildren(...(task?.events.slice(-12).reverse() || []).map(event => {
      const li = document.createElement('li'), time = document.createElement('time'); time.textContent = stamp(event.at);
      li.append(time, document.createTextNode(event.message)); return li;
    }));
    renderRows();
  }
  function renderRows() {
    const filter = $('filter').value, search = C.compact($('search').value).toLowerCase();
    const rows = (task?.records || []).filter(r => {
      if (filter === 'history' ? r.inCurrentScope !== false : r.inCurrentScope === false) return false;
      if (['available', 'reported', 'unknown'].includes(filter) && r.reportState !== filter) return false;
      if (['pending', 'verified'].includes(filter) && (r.review?.status || 'pending') !== filter) return false;
      if (filter === 'no_text' && r.contentType !== 'no_text') return false;
      if (filter === 'conflict' && !r.conflict) return false;
      return C.compact([r.orderId, r.productId, r.content].join(' ')).toLowerCase().includes(search);
    });
    const maxPage = Math.max(1, Math.ceil(rows.length / 20)); page = Math.min(page, maxPage);
    $('visible-count').textContent = `· ${rows.length} 条`;
    $('rows').replaceChildren(...rows.slice((page - 1) * 20, page * 20).map(r => {
      const tr = document.createElement('tr');
      const cells = Array.from({ length: 5 }, () => document.createElement('td'));
      const content = document.createElement('div'); content.className = 'snippet'; content.textContent = r.content;
      const order = document.createElement('small'); order.textContent = `订单 ${r.orderId} · 商品 ${r.productId}`;
      cells[0].append(content, order);
      const stars = document.createElement('div'); stars.className = 'stars'; stars.textContent = '★'.repeat(r.stars) + '☆'.repeat(5 - r.stars);
      const time = document.createElement('small'); time.textContent = r.reviewTime; cells[1].append(stars, time);
      cells[2].append(badge(C.reportLabels[r.reportState], r.reportState === 'reported' ? 'good' : r.reportState === 'available' ? 'blue' : 'warn'));
      if (r.conflict) cells[2].append(document.createElement('br'), badge('内容冲突', 'warn'));
      cells[3].append(badge(C.reviewLabels[r.review?.status || 'pending']));
      if (r.reportPreparation) {
        const state = document.createElement('small'); state.className = 'report-last-result'; state.textContent = r.reportPreparation.message; cells[3].append(state);
      }
      if (r.reportBatchResult) {
        const result = document.createElement('small'); result.className = 'report-last-result';
        result.textContent = `批量：${C.batchItemLabels[r.reportBatchResult.status] || r.reportBatchResult.status} · ${r.reportBatchResult.message || ''}`; cells[3].append(result);
      }
      const edit = document.createElement('button'); edit.textContent = r.reportState === 'reported' ? '查看（已举报）' : r.reportState === 'available' ? '举报 / 核验' : '查看状态'; edit.disabled = !!state.active;
      edit.addEventListener('click', () => openReview(r)); cells[4].append(edit); tr.append(...cells); return tr;
    }));
    $('empty').hidden = rows.length > 0;
    $('page-label').textContent = `第 ${page} / ${maxPage} 页 · 每页20条（插件清单）`;
    $('prev').disabled = page <= 1; $('next').disabled = page >= maxPage;
  }
  function openReview(row) {
    reviewKey = row.key; reviewTaskId = task.id;
    $('review-meta').textContent = `${task.shop.name} · 订单 ${row.orderId} · ${row.stars}星 · ${row.reviewTime}`;
    $('review-content').textContent = row.content;
    $('review-warning').textContent = row.conflict ? '该评价多次扫描时内容或星级发生冲突，需要回到原页面核实。' : row.reportState !== 'available' ? '这条记录没有明确可用的举报入口，仅可保存待核验或不举报。' : '请针对这一条评价填写核实结果。保存不会向平台提交。';
    const review = row.review || {};
    $('review-status').value = review.status || 'pending'; $('reason').value = review.reason || '';
    $('facts').value = review.facts || ''; $('evidence').value = review.evidence || ''; $('attested').checked = !!review.attested;
    $('open-report').disabled = review.status !== 'verified' || row.reportState !== 'available' || row.conflict || row.inCurrentScope === false;
    $('review-error').textContent = ''; $('review-dialog').showModal();
  }
  function action(id, fn) {
    $(id).addEventListener('click', async () => {
      $(id).disabled = true;
      try { await fn(); } catch (e) { notice(e.message, true); }
      finally { try { await refresh(); } catch (e) { notice(e.message, true); } }
    });
  }
  action('refresh', async () => {});
  action('batch-report', async () => {
    await api('BATCH_START', { id: task.id, tabId: Number($('tab').value) });
    notice('已启动批量队列。请在平台核对并手动提交当前条，确认已举报后自动继续；可用上方暂停/停止按钮控制队列。');
  });
  action('batch-resume', async () => {
    await api('BATCH_START', { id: task.id, tabId: Number($('tab').value), resume: true });
    notice('正在恢复批量队列；先核对上一条结果，不重复打开未确认的举报。');
  });
  action('batch-skip', async () => { await api('CONTROL', { command: 'skip' }); notice('已请求跳过当前条；关闭弹窗并记录后继续。'); });
  action('batch-export', async () => download(filename('批量处理记录.csv'), C.exportBatchCsv(task), 'text/csv;charset=utf-8'));
  $('import-accounts').addEventListener('click', () => $('account-file').click());
  $('account-file').addEventListener('change', async () => {
    try {
      const file = $('account-file').files[0]; if (!file) return;
      if (file.size > 2000000) throw new Error('映射文件过大');
      const map = C.normalizeAccountMap(JSON.parse(await file.text()));
      const count = await api('IMPORT_ACCOUNTS', { map });
      notice(`已导入${count}条店铺行号映射，原Excel未修改。`); await refresh();
    } catch (e) { notice(e.message, true); }
    finally { $('account-file').value = ''; }
  });
  action('bind', async () => { picking = true; try { const binding = await api('PICK', { tabId: Number($('tab').value) }); notice(`已识别「${binding.name}」，可以开始扫描。`); } finally { picking = false; } });
  action('start', async () => {
    const tabId = Number($('tab').value);
    if (!state.tabs.find(t => t.id === tabId)?.url?.includes('/goods/evaluation/')) { await api('OPEN_EVALUATION', { tabId }); return; }
    taskId = await api('START', { tabId, criteria: readCriteria() }); criteriaDirty = false; page = 1; notice('查询已开始，逐页读取所选星级。请保留当前页面，不要手动改变筛选条件。');
  });
  $('close-panel').addEventListener('click', () => api('PANEL_CLOSE').catch(e => notice(e.message, true)));
  action('open-full', async () => api('OPEN_FULL', { tabId: Number($('tab').value) }));
  action('resume', async () => { taskId = await api('START', { tabId: Number($('tab').value), id: task.id }); notice('正在从各星级第1页复核，并与已保存记录去重合并。'); });
  for (const id of ['pause', 'stop']) action(id, async () => { await api('CONTROL', { command: id }); notice('控制指令已发送，执行器会在下一检查点停止页面操作。'); });
  action('diagnostic', async () => { download('评价页面诊断.json', JSON.stringify(await api('DIAGNOSTIC', { tabId: Number($('tab').value) }), null, 2), 'application/json'); });
  action('csv', async () => download(filename('评价清单.csv'), C.exportCsv(task), 'text/csv;charset=utf-8'));
  action('json', async () => download(filename('任务备份.json'), JSON.stringify(task, null, 2), 'application/json'));
  action('summary', async () => {
    const match = C.matchAccount(state.accountMap, task.shop.name);
    download(filename('店铺扫描汇总.csv'), C.csv([
      ['店铺标识', '店铺名称', '任务ID', '处理状态（D）', '本次举报条数（E）', '本轮采集条数', '扫描完整性', '记账说明', '来源账号表', '工作表', '原表行号'],
      [task.shop.shopKey, task.shop.name, task.id, task.status === 'completed' ? '查询完成（举报结果待核对）' : '查询未完成', '', C.stats(task).total, task.completeness, '尚未接入平台提交成功回执，举报条数留空，须核对后记账', match.source || '', match.sheet || '', match.row || '']
    ]), 'text/csv;charset=utf-8');
  });
  action('delete', async () => { if (confirm('删除当前本地任务及核验记录？如需保留，请先导出。')) { await api('DELETE', { id: task.id }); taskId = ''; } });
  $('tab').addEventListener('change', () => refresh().catch(e => notice(e.message, true)));
  $('tasks').addEventListener('change', async () => { taskId = $('tasks').value; page = 1; await refresh().catch(e => notice(e.message, true)); if (task) writeCriteria(task.criteria); criteriaDirty = false; render(); });
  $('query-fields').addEventListener('input', () => { criteriaDirty = true; $('resume').disabled = true; });
  $('reset-query').addEventListener('click', () => { writeCriteria(); criteriaDirty = true; $('resume').disabled = true; });
  for (const id of ['filter', 'search']) $(id).addEventListener('input', () => { page = 1; renderRows(); });
  $('prev').addEventListener('click', () => { page--; renderRows(); }); $('next').addEventListener('click', () => { page++; renderRows(); });
  $('close-review').addEventListener('click', () => $('review-dialog').close());
  $('review-form').addEventListener('input', () => { $('open-report').disabled = true; });
  $('open-report').addEventListener('click', async () => {
    $('open-report').disabled = true;
    try {
      await api('PREPARE_REPORT', { id: reviewTaskId, key: reviewKey, tabId: Number($('tab').value) });
      $('review-dialog').close(); notice('正在定位所选评价并核对平台举报状态；不会自动点击提交。');
      await refresh();
    } catch (e) { $('review-error').textContent = e.message; }
  });
  $('review-form').addEventListener('submit', async e => {
    e.preventDefault(); $('save-review').disabled = true;
    try {
      task = await api('REVIEW', { id: reviewTaskId, key: reviewKey, review: {
        status: $('review-status').value, reason: $('reason').value, facts: $('facts').value,
        evidence: $('evidence').value, attested: $('attested').checked
      } });
      const saved = task.records.find(r => r.key === reviewKey);
      $('open-report').disabled = saved.review.status !== 'verified' || saved.reportState !== 'available' || saved.conflict;
      render(); $('review-error').textContent = '核验已保存。可继续打开平台表单，或关闭窗口。'; notice('核验记录已保存在本地，未提交举报。');
    } catch (error) { $('review-error').textContent = error.message; }
    finally { $('save-review').disabled = false; }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    clearTimeout(timer); timer = setTimeout(() => refresh().catch(e => notice(e.message, true)), 250);
  });
  window.addEventListener('focus', () => refresh().catch(e => notice(e.message, true)));
  if (embedded) setInterval(() => {
    if (!picking && document.visibilityState === 'visible') refresh().catch(e => notice(e.message, true));
  }, 3500);
  if (params.get('error')) notice(params.get('error'), true);
  refresh().catch(e => notice(e.message, true));
})();
