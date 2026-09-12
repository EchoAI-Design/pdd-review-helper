(() => {
  'use strict';
  if (globalThis.__pddHelperLoaded) return;
  globalThis.__pddHelperLoaded = true;
  let runner = null, token = null, cancelPicker = null;
  let preparing = false, prepareControl = null;
  let batchRunner = null;
  let panelHost, panelRoot, panelInfo, panelWanted;
  function setPanel(open, save = true) {
    panelWanted = open;
    if (!panelInfo) return;
    if (!panelHost?.isConnected) {
      panelHost = document.createElement('div'); panelHost.dataset.pddHelper = 'panel';
      panelRoot = panelHost.attachShadow({ mode: 'closed' });
      document.documentElement.append(panelHost);
    }
    panelHost.style.cssText = open
      ? 'all:initial;position:fixed!important;left:0!important;top:0!important;width:min(390px,95vw)!important;height:100vh!important;z-index:2147483647!important;display:block!important;'
      : 'all:initial;position:fixed!important;left:0!important;top:42%!important;width:34px!important;height:116px!important;z-index:2147483647!important;display:block!important;';
    panelRoot.replaceChildren();
    if (open) {
      const frame = document.createElement('iframe');
      frame.title = '评价巡检助手';
      frame.src = chrome.runtime.getURL('app.html') + `?panel=1&cap=${encodeURIComponent(panelInfo.token)}`;
      frame.style.cssText = 'width:100%;height:100%;border:0;display:block;background:#f5f7fb;box-shadow:5px 0 24px #11243a26;border-right:1px solid #dce4ef;';
      panelRoot.append(frame);
    } else {
      const button = document.createElement('button'); button.textContent = '评价助手'; button.title = '展开评价巡检助手';
      button.style.cssText = 'width:34px;height:116px;border:0;border-radius:0 10px 10px 0;background:#245dde;color:white;writing-mode:vertical-rl;letter-spacing:3px;font:14px sans-serif;cursor:pointer;box-shadow:2px 3px 12px #102c5030;';
      button.onclick = () => setPanel(true); panelRoot.append(button);
    }
    if (save) chrome.runtime.sendMessage({ type: 'PANEL_VISIBILITY', cap: panelInfo.token, open }).catch(() => {});
  }
  let badge;
  function show(message) {
    if (panelWanted) { if (badge) badge.style.display = 'none'; return; }
    if (!badge) {
      badge = document.createElement('div'); badge.dataset.pddHelper = 'status';
      Object.assign(badge.style, { position: 'fixed', right: '20px', bottom: '20px', zIndex: '2147483646',
        maxWidth: '400px', padding: '14px 18px', background: '#14253c', color: 'white',
        borderRadius: '12px', boxShadow: '0 4px 24px #0003', font: '14px/1.6 sans-serif', pointerEvents: 'none' });
      document.documentElement.append(badge);
    }
    badge.style.display = 'block';
    badge.textContent = '评价巡检助手 · ' + message;
  }
  function selectorFor(el) {
    const unique = selector => document.querySelectorAll(selector).length === 1;
    if (el.id && unique('#' + CSS.escape(el.id))) return '#' + CSS.escape(el.id);
    const parts = [];
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const siblings = [...n.parentElement.children].filter(x => x.tagName === n.tagName);
      parts.unshift(n.tagName.toLowerCase() + `:nth-of-type(${siblings.indexOf(n) + 1})`);
      const path = parts.join(' > ');
      if (unique(path)) return path;
    }
    throw new Error('无法定位所选元素');
  }
  function pickShop() {
    if (cancelPicker) cancelPicker('重新开始选择');
    return new Promise(resolve => {
      let target, oldOutline, timer;
      const clearHighlight = () => { if (target) target.style.outline = oldOutline; target = null; };
      const end = value => {
        clearTimeout(timer); clearHighlight();
        document.removeEventListener('mouseover', hover, true);
        document.removeEventListener('click', choose, true);
        document.removeEventListener('keydown', key, true); cancelPicker = null;
        resolve(value);
      };
      const hover = e => {
        clearHighlight();
        if (!(e.target instanceof HTMLElement) || e.target.closest('[data-pdd-helper]')) return;
        target = e.target; oldOutline = target.style.outline; target.style.outline = '2px solid #2563eb';
      };
      const choose = e => {
        e.preventDefault(); e.stopImmediatePropagation();
        try {
          const name = PddCore.normalize(e.target.innerText);
          if (!name || name.length > 80 || /\n/.test(name)) throw new Error('请点选仅含店铺名称的文字，不能选择整个菜单');
          const selector = selectorFor(e.target); end({ name, selector });
          setPanel(true); show(`已识别「${name}」，可在左侧面板开始扫描`);
        } catch (error) { show(error.message + '；Esc 取消'); }
      };
      const key = e => { if (e.key === 'Escape') { e.preventDefault(); end({ error: '已取消店铺绑定' }); show('绑定已取消'); } };
      cancelPicker = message => end({ error: message });
      document.addEventListener('mouseover', hover, true); document.addEventListener('click', choose, true);
      document.addEventListener('keydown', key, true);
      timer = setTimeout(() => { end({ error: '选择超时，请重试' }); show('绑定选择已超时'); }, 60000);
      show('请点击右上角的店铺名称文字来绑定当前店铺；Esc 取消');
    });
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message.type === 'PDD_PING') { respond({ running: !!runner?.running || preparing || !!batchRunner?.running, token, version: '0.4.0' }); return false; }
    if (message.type === 'PDD_PANEL') { setPanel(message.open); respond({ ok: true }); return false; }
    if (message.type === 'PDD_DETECT') {
      try { respond(PddShop.detect(message.previous)); } catch (e) { respond({ error: e.message }); }
      return false;
    }
    if (message.type === 'PDD_FILTER_OPTIONS') {
      try { respond({ tags: new PddAdapter().tagOptions().map(({ value, label }) => ({ value, label })) }); }
      catch { respond({ tags: [] }); }
      return false;
    }
    if (message.type === 'PDD_PICK') { setPanel(false, false); pickShop().then(respond); return true; }
    if (message.type === 'PDD_DIAGNOSTIC') {
      try { respond({ ...new PddAdapter(message.binding).diagnostic(), shopDetection: PddShop.detect(message.binding), version: '0.4.0' }); } catch (e) { respond({ error: e.message }); }
      return false;
    }
    if (message.type === 'PDD_CONTROL') {
      if (token === message.token && runner?.running) runner.control(message.command);
      if (token === message.token && preparing) prepareControl = message.command;
      if (token === message.token && batchRunner?.running) batchRunner.control(message.command);
      respond({ ok: true }); return false;
    }
    if (message.type === 'PDD_RUN') {
      if (runner?.running || preparing || batchRunner?.running || cancelPicker) { respond({ ok: false, error: '页面已有任务在执行' }); return false; }
      try {
        const adapter = new PddAdapter(message.task.shop); adapter.assertShop();
        token = message.token;
        runner = new PddScanRunner(adapter, async task => {
          const response = await chrome.runtime.sendMessage({ type: 'CHECKPOINT', token, task });
          if (!response?.ok) throw new Error(response?.error || '无法保存进度');
        }, task => show(task.message));
        // run() sets running synchronously before its first await, so ownership is observable immediately.
        runner.run(message.task).catch(e => show('进度保存失败，执行已停止：' + e.message));
        respond({ ok: true });
      } catch (e) { respond({ ok: false, error: e.message }); }
      return false;
    }
    if (message.type === 'PDD_PREPARE_REPORT') {
      if (runner?.running || preparing || batchRunner?.running || cancelPicker) { respond({ ok: false, error: '页面已有任务在执行' }); return false; }
      preparing = true; prepareControl = null; token = message.token;
      const send = async (type, data) => {
        const reply = await chrome.runtime.sendMessage({ type, token: message.token, taskId: message.task.id, ...data });
        if (!reply?.ok) throw new Error(reply?.error || '任务连接失效');
      };
      const guard = async () => { if (prepareControl) throw new Error('已停止定位举报，尚未提交'); };
      new PddReportPreparer(new PddAdapter(message.task.shop), text => send('REPORT_PROGRESS', { message: text }))
        .run(message.record, message.task.criteria, guard)
        .catch(e => ({ status: 'error', message: e.message }))
        .then(result => send('REPORT_RESULT', { result, key: message.record.key }))
        .catch(e => show(e.message)).finally(() => { preparing = false; });
      respond({ ok: true }); return false;
    }
    if (message.type === 'PDD_BATCH_RUN') {
      if (runner?.running || preparing || batchRunner?.running || cancelPicker) { respond({ ok: false, error: '页面已有任务在执行' }); return false; }
      token = message.token;
      batchRunner = new PddBatchReporter(new PddAdapter(message.task.shop), async batch => {
        const reply = await chrome.runtime.sendMessage({ type: 'BATCH_CHECKPOINT', token: message.token, taskId: message.task.id, batch });
        if (!reply?.ok) throw new Error(reply?.error || '批量进度保存失败');
        show(batch.message);
      });
      batchRunner.run(message.task).catch(e => show('批量处理已停止：' + e.message));
      respond({ ok: true }); return false;
    }
    return false;
  });
  chrome.runtime.sendMessage({ type: 'PANEL_INIT' }).then(reply => {
    if (!reply?.ok) throw new Error(reply?.error || '面板初始化失败');
    panelInfo = reply.data; setPanel(panelWanted ?? panelInfo.open, false);
  }).catch(e => show('面板连接失败：' + e.message));
})();
