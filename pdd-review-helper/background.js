/* All persistent writes are serialized here. No requests to merchant APIs. */
importScripts('core.js');
const C = PddCore;
const PREFIX = 'task:';
const VERSION = '0.4.0';
const pageMessage = (tabId, message) => chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
let queue = Promise.resolve();
const serialized = fn => {
  const result = queue.then(fn); queue = result.catch(() => {}); return result;
};
const get = async key => (await chrome.storage.local.get(key))[key];
const validUrl = url => { try { return new URL(url).origin === 'https://mms.pinduoduo.com'; } catch { return false; } };
const getTask = async id => {
  const task = await get(PREFIX + id);
  if (!task) throw new Error('找不到任务，请重新选择');
  return task;
};
async function saveTask(task) {
  const index = await get('taskIndex') || [];
  const summary = { id: task.id, name: task.shop.name, tabId: task.shop.tabId, shopKey: task.shop.shopKey, status: task.status, updatedAt: task.updatedAt,
    total: C.stats(task).total, message: task.message };
  await chrome.storage.local.set({ [PREFIX + task.id]: task,
    taskIndex: [summary, ...index.filter(item => item.id !== task.id)] });
}
async function activeLock() {
  const lock = await get('active');
  if (!lock) return null;
  let state;
  try { state = await chrome.tabs.sendMessage(lock.tabId, { type: 'PDD_PING' }); } catch { /* page closed/reloaded */ }
  if (state?.running && state.token === lock.token) return lock;
  const task = await getTask(lock.taskId);
  if (lock.kind === 'report') {
    task.message = '举报定位已中断，请核对平台页面后重试；没有计入举报成功数'; task.updatedAt = Date.now(); await saveTask(task);
  }
  if (lock.kind === 'batch' && task.batch && !['completed', 'paused', 'stopped', 'needs_attention'].includes(task.batch.status)) {
    task.batch.status = 'paused'; task.batch.message = '页面已刷新或关闭，批量队列已暂停；继续时先核对上一条结果';
    const item = task.batch.items[task.batch.cursor];
    if (item && ['locating', 'waiting_manual'].includes(item.state)) { item.state = 'unconfirmed'; item.message = task.batch.message; }
    task.message = task.batch.message; task.updatedAt = Date.now(); await saveTask(task);
  }
  if (task.status === 'running') {
    task.status = 'paused'; task.completeness = 'incomplete';
    task.message = '原页面已关闭、刷新或执行器已结束；已保存的记录可继续复核'; task.updatedAt = Date.now();
    await saveTask(task);
  }
  await chrome.storage.local.remove('active');
  return null;
}
async function merchantTab(id) {
  const tab = await chrome.tabs.get(Number(id));
  if (!validUrl(tab.url)) throw new Error('请选择已登录的拼多多商家页面');
  return tab;
}
async function ensureContent(tabId) {
  await merchantTab(tabId);
  let ping;
  try { ping = await pageMessage(tabId, { type: 'PDD_PING' }); } catch { /* Newly installed: attach to the existing page. */ }
  if (ping?.version === VERSION) return;
  if (ping) throw new Error('此页面仍运行旧版插件，请刷新一次商家页面以完成更新');
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['core.js', 'adapter.js', 'scanner.js', 'shop.js', 'reporter.js', 'batch.js', 'content.js'] });
    const ready = await pageMessage(tabId, { type: 'PDD_PING' });
    if (ready?.version !== VERSION) throw new Error('脚本版本未更新');
  } catch (e) { throw new Error('无法连接商家页面，请检查扩展的网站访问权限，并刷新页面重试。' + e.message); }
}
async function detectBinding(tabId) {
  await ensureContent(tabId);
  const bindings = await get('bindings') || {};
  const detected = await pageMessage(tabId, { type: 'PDD_DETECT', previous: bindings[tabId] });
  if (!detected?.name || !detected?.selector) throw new Error(detected?.error || '暂未识别到当前店铺');
  const old = bindings[tabId];
  const binding = { ...detected, tabId, shopKey: `${tabId}:${detected.name}`, boundAt: old?.boundAt || Date.now() };
  if (JSON.stringify(binding) !== JSON.stringify(old)) { bindings[tabId] = binding; await chrome.storage.local.set({ bindings }); }
  return binding;
}
async function dispatch(message, sender) {
  if (sender.id !== chrome.runtime.id) throw new Error('未知消息来源');
  if (message.type === 'BATCH_CHECKPOINT') {
    const lock = await get('active');
    if (!validUrl(sender.url) || sender.frameId !== 0 || lock?.kind !== 'batch' || lock.token !== message.token || lock.tabId !== sender.tab?.id || lock.taskId !== message.taskId) throw new Error('批量队列连接已失效');
    const task = await getTask(lock.taskId), batch = message.batch;
    if (!batch || batch.id !== task.batch?.id || JSON.stringify(batch.items?.map(item => item.key)) !== JSON.stringify(task.batch.items.map(item => item.key)) ||
        !Number.isInteger(batch.cursor) || batch.cursor < task.batch.cursor || batch.cursor > batch.items.length ||
        !['running', 'waiting', 'completed', 'paused', 'stopped', 'needs_attention'].includes(batch.status) || batch.items.some(item => !C.batchItemLabels[item.state])) throw new Error('批量进度校验失败');
    const terminal = item => ['confirmed_reported', 'skipped_reported', 'skipped_type_disabled', 'skipped_unavailable', 'skipped_manual', 'not_found'].includes(item.state);
    if (batch.items.slice(0, batch.cursor).some(item => !terminal(item)) || (batch.status === 'completed' && (batch.cursor !== batch.items.length || batch.items.some(item => !terminal(item))))) throw new Error('批量结束状态与逐条记录不一致');
    task.batch = batch; task.message = batch.message; task.updatedAt = Date.now();
    for (const item of batch.items) {
      const record = task.records.find(row => row.key === item.key);
      if (!record || item.state === 'pending') continue;
      record.reportBatchResult = { batchId: batch.id, status: item.state, message: item.message, at: item.updatedAt };
      if (['confirmed_reported', 'skipped_reported'].includes(item.state)) record.reportState = 'reported';
    }
    if (task.events.at(-1)?.message !== batch.message) task.events.push({ at: Date.now(), message: batch.message });
    task.events = task.events.slice(-200); await saveTask(task);
    if (!['running', 'waiting'].includes(batch.status)) await chrome.storage.local.remove('active');
    return true;
  }
  if (['REPORT_PROGRESS', 'REPORT_RESULT'].includes(message.type)) {
    const lock = await get('active');
    if (!validUrl(sender.url) || sender.frameId !== 0 || !lock || lock.kind !== 'report' || lock.token !== message.token || lock.tabId !== sender.tab?.id || lock.taskId !== message.taskId) throw new Error('举报定位任务已失效');
    const task = await getTask(lock.taskId);
    task.message = String(message.message || message.result?.message || '').slice(0, 1000); task.updatedAt = Date.now();
    task.events.push({ at: Date.now(), message: task.message }); task.events = task.events.slice(-200);
    if (message.type === 'REPORT_RESULT') {
      const row = task.records.find(r => r.key === lock.key);
      if (row) {
        row.reportPreparation = { ...message.result, at: Date.now() };
        if (message.result.status === 'skipped_reported') row.reportState = 'reported';
      }
    }
    await saveTask(task);
    if (message.type === 'REPORT_RESULT') await chrome.storage.local.remove('active');
    return true;
  }
  if (message.type === 'PANEL_INIT') {
    if (!validUrl(sender.url) || !sender.tab || sender.frameId !== 0) throw new Error('无效页面来源');
    const key = `panel:${sender.tab.id}`, previous = await get(key);
    const panel = { token: crypto.randomUUID(), open: previous?.open !== false };
    await chrome.storage.local.set({ [key]: panel });
    return { ...panel, tabId: sender.tab.id };
  }
  if (message.type === 'PANEL_VISIBILITY') {
    if (!validUrl(sender.url) || !sender.tab || sender.frameId !== 0) throw new Error('无效页面来源');
    const key = `panel:${sender.tab.id}`, panel = await get(key);
    if (!panel || panel.token !== message.cap) throw new Error('面板已失效');
    await chrome.storage.local.set({ [key]: { ...panel, open: !!message.open } }); return true;
  }
  if (message.type === 'CHECKPOINT') {
    const lock = await get('active');
    if (!validUrl(sender.tab?.url) || !lock || lock.tabId !== sender.tab.id ||
      lock.token !== message.token || lock.taskId !== message.task?.id) throw new Error('执行权已失效，扫描停止');
    const previous = await getTask(lock.taskId);
    if (message.task.shop.shopKey !== previous.shop.shopKey) throw new Error('任务店铺不一致');
    message.task.shop = previous.shop; message.task.submittedCount = 0;
    await saveTask(message.task);
    if (message.task.status !== 'running') await chrome.storage.local.remove('active');
    return true;
  }
  // Embedded UI requires a capability created by our top-frame content script.
  const senderUrl = new URL(sender.url || 'https://invalid.local');
  if (senderUrl.protocol !== 'chrome-extension:' || senderUrl.hostname !== chrome.runtime.id || senderUrl.pathname !== '/app.html') throw new Error('不接受网页发送的管理命令');
  const embedded = sender.frameId > 0;
  const panelTab = embedded ? sender.tab?.id : null;
  if (embedded) {
    const panel = await get(`panel:${panelTab}`);
    if (!validUrl(sender.tab?.url) || !panel || panel.token !== message.cap || panel.token !== senderUrl.searchParams.get('cap')) throw new Error('面板连接已过期，请收起后重新打开');
    message.tabId = panelTab;
    if (['TASK', 'REVIEW', 'DELETE', 'PREPARE_REPORT', 'BATCH_START'].includes(message.type) && (await getTask(message.id)).shop.tabId !== panelTab) throw new Error('该任务不属于当前页面');
  }
  switch (message.type) {
    case 'STATE': {
      const lock = await activeLock();
      const tabs = (await chrome.tabs.query({ url: 'https://mms.pinduoduo.com/*' })).filter(t => !embedded || t.id === panelTab)
        .map(t => ({ id: t.id, title: t.title, url: t.url }));
      const selectedId = embedded ? panelTab : tabs.find(t => t.id === Number(message.tabId))?.id || tabs[0]?.id;
      let detectionError = '';
      if (selectedId) try { await detectBinding(selectedId); } catch (e) { detectionError = e.message; }
      const bindings = await get('bindings') || {};
      if (detectionError) delete bindings[selectedId];
      let tasks = await get('taskIndex') || [];
      if (embedded) {
        const local = [];
        for (const item of tasks) if ((item.tabId ?? (await getTask(item.id)).shop.tabId) === panelTab) local.push(item);
        tasks = local;
      }
      let filterOptions = { tags: [] };
      if (selectedId && !detectionError) try { filterOptions = await pageMessage(selectedId, { type: 'PDD_FILTER_OPTIONS' }); } catch { /* Optional controls not ready. */ }
      return { active: lock, tabs, bindings, tasks, detectionError, panelTab, filterOptions, accountMap: await get('accountMap') || null };
    }
    case 'IMPORT_ACCOUNTS': {
      if (await activeLock()) throw new Error('请先暂停任务再更新账号表映射');
      const accountMap = C.normalizeAccountMap(message.map);
      await chrome.storage.local.set({ accountMap }); return accountMap.rows.length;
    }
    case 'PANEL_CLOSE': {
      const tab = await merchantTab(message.tabId);
      await pageMessage(tab.id, { type: 'PDD_PANEL', open: false }); return true;
    }
    case 'OPEN_FULL': return chrome.tabs.create({ url: chrome.runtime.getURL('app.html') + `?tab=${message.tabId}` });
    case 'OPEN_EVALUATION': {
      if (await activeLock()) throw new Error('请先暂停扫描再打开评价管理');
      const tab = await merchantTab(message.tabId);
      await chrome.tabs.update(tab.id, { url: 'https://mms.pinduoduo.com/goods/evaluation/index' }); return true;
    }
    case 'TASK': return getTask(message.id);
    case 'BATCH_START': {
      if (await activeLock()) throw new Error('请先暂停当前任务');
      const task = await getTask(message.id);
      const tab = await merchantTab(message.tabId ?? task.shop.tabId), binding = await detectBinding(tab.id);
      if (binding.shopKey !== task.shop.shopKey) throw new Error('当前店铺与队列所属店铺不一致');
      if (task.day !== C.chinaDay(Date.now())) throw new Error('任务日期已变化，请核对上一条结果并重新查询');
      if (message.resume) {
        if (!task.batch || task.batch.status === 'completed' || task.batch.cursor >= task.batch.items.length) throw new Error('没有未完成的批量队列');
      } else {
        if (task.batch && task.batch.status !== 'completed' && task.batch.cursor < task.batch.items.length) throw new Error('请先继续未完成的批量队列并核对上一条结果');
        task.batch = C.newBatch(task);
      }
      task.shop = binding; task.batch.status = 'running'; task.batch.message = '正在连接批量队列';
      task.message = task.batch.message; task.updatedAt = Date.now(); await saveTask(task);
      const token = crypto.randomUUID();
      await chrome.storage.local.set({ active: { kind: 'batch', taskId: task.id, tabId: tab.id, token } });
      try {
        const result = await pageMessage(tab.id, { type: 'PDD_BATCH_RUN', token, task });
        if (!result?.ok) throw new Error(result?.error || '页面拒绝启动批量队列');
      } catch (e) {
        await chrome.storage.local.remove('active'); task.batch.status = 'needs_attention'; task.batch.message = e.message;
        task.message = e.message; await saveTask(task); throw e;
      }
      return true;
    }
    case 'PREPARE_REPORT': {
      if (await activeLock()) throw new Error('请先暂停当前任务');
      const task = await getTask(message.id), record = task.records.find(r => r.key === message.key);
      if (!record || record.review?.status !== 'verified' || record.inCurrentScope === false) throw new Error('请先逐条保存事实与证据核验结果');
      C.validateReview(record, record.review);
      const tab = await merchantTab(message.tabId ?? task.shop.tabId), binding = await detectBinding(tab.id);
      if (binding.shopKey !== task.shop.shopKey) throw new Error('当前店铺与评价所属店铺不一致');
      task.shop = binding; await saveTask(task);
      const token = crypto.randomUUID();
      await chrome.storage.local.set({ active: { kind: 'report', taskId: task.id, tabId: tab.id, token, key: record.key } });
      try {
        const result = await pageMessage(tab.id, { type: 'PDD_PREPARE_REPORT', token, task, record });
        if (!result?.ok) throw new Error(result?.error || '无法启动举报定位');
      } catch (e) { await chrome.storage.local.remove('active'); throw e; }
      return true;
    }
    case 'PICK': {
      if (await activeLock()) throw new Error('请先暂停当前扫描，再绑定店铺');
      const tab = await merchantTab(message.tabId);
      await ensureContent(tab.id);
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      const binding = await chrome.tabs.sendMessage(tab.id, { type: 'PDD_PICK' });
      if (!binding?.name || !binding?.selector) throw new Error(binding?.error || '未选中店铺名称');
      const bindings = await get('bindings') || {};
      // This release binds a user-confirmed display name, not an unverified merchant ID.
      const result = { ...binding, source: 'manual', shopKey: `${tab.id}:${binding.name}`, boundAt: Date.now(), tabId: tab.id };
      bindings[tab.id] = result; await chrome.storage.local.set({ bindings });
      return result;
    }
    case 'START': {
      if (await activeLock()) throw new Error('已有扫描正在运行，请先暂停或停止');
      const tab = await merchantTab(message.tabId);
      const binding = await detectBinding(tab.id);
      let task = message.id ? await getTask(message.id) : C.newTask(binding);
      if (!message.id) task.criteria = C.normalizeCriteria(message.criteria);
      if (task.shop.shopKey !== binding.shopKey) throw new Error('当前店铺已变化，请为新店铺新建扫描');
      task.shop = binding;
      if (task.day !== C.chinaDay(Date.now())) throw new Error('任务日期已变化，请新建扫描');
      const token = crypto.randomUUID();
      task.status = 'running'; task.message = '正在连接评价页面'; task.updatedAt = Date.now();
      await saveTask(task);
      await chrome.storage.local.set({ active: { taskId: task.id, tabId: tab.id, token } });
      try {
        const result = await chrome.tabs.sendMessage(tab.id, { type: 'PDD_RUN', task, token });
        if (!result?.ok) throw new Error(result?.error || '页面拒绝执行');
      } catch (e) {
        await chrome.storage.local.remove('active'); task.status = 'needs_attention';
        task.message = `无法启动：${e.message}。安装后请刷新评价管理页面。`; task.completeness = 'incomplete';
        await saveTask(task); throw new Error(task.message);
      }
      return task.id;
    }
    case 'CONTROL': {
      if (!['pause', 'stop', 'skip'].includes(message.command)) throw new Error('无效控制命令');
      const lock = await activeLock();
      if (!lock) return false;
      if (embedded && lock.tabId !== panelTab) throw new Error('当前扫描在其他页面运行');
      if (message.command === 'skip' && (lock.kind !== 'batch' || (await getTask(lock.taskId)).batch?.status !== 'waiting')) throw new Error('只能跳过正在等待平台确认的当前条');
      await chrome.tabs.sendMessage(lock.tabId, { type: 'PDD_CONTROL', command: message.command, token: lock.token });
      return true;
    }
    case 'DIAGNOSTIC': {
      const tab = await merchantTab(message.tabId);
      await ensureContent(tab.id);
      const binding = (await get('bindings') || {})[tab.id];
      return chrome.tabs.sendMessage(tab.id, { type: 'PDD_DIAGNOSTIC', binding });
    }
    case 'REVIEW': {
      if (await activeLock()) throw new Error('请先暂停扫描，再保存核验内容');
      const task = await getTask(message.id), row = task.records.find(r => r.key === message.key);
      if (!row) throw new Error('找不到这条评价');
      if (row.inCurrentScope === false && message.review.status === 'verified') throw new Error('历史记录不能直接进入本轮核验队列');
      row.review = C.validateReview(row, message.review); task.updatedAt = Date.now();
      await saveTask(task); return task;
    }
    case 'DELETE': {
      if ((await activeLock())?.taskId === message.id) throw new Error('请先停止该任务');
      const index = await get('taskIndex') || [];
      await chrome.storage.local.set({ taskIndex: index.filter(t => t.id !== message.id) });
      await chrome.storage.local.remove(PREFIX + message.id); return true;
    }
    default: throw new Error('不支持的命令');
  }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  serialized(() => dispatch(message, sender)).then(data => respond({ ok: true, data }),
    e => respond({ ok: false, error: e.message }));
  return true;
});
chrome.action.onClicked.addListener(async tab => {
  if (validUrl(tab.url)) {
    try { await ensureContent(tab.id); await pageMessage(tab.id, { type: 'PDD_PANEL', open: true }); return; }
    catch (e) { await chrome.tabs.create({ url: chrome.runtime.getURL('app.html') + `?tab=${tab.id}&error=${encodeURIComponent(e.message)}` }); return; }
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL('app.html') });
});
