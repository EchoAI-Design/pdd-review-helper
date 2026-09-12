/* Detect only visible merchant identity elements; never cookies or private APIs. */
(() => {
  const C = PddCore;
  function visible(el) {
    return !!el?.getClientRects().length && getComputedStyle(el).visibility !== 'hidden' &&
      !el.closest('[data-pdd-helper],table,[role="menu"],[role="listbox"],[role="dialog"]');
  }
  function selectorFor(el) {
    const unique = selector => document.querySelectorAll(selector).length === 1;
    if (el.id && unique('#' + CSS.escape(el.id))) return '#' + CSS.escape(el.id);
    const parts = [];
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const siblings = [...n.parentElement.children].filter(x => x.tagName === n.tagName);
      parts.unshift(n.tagName.toLowerCase() + `:nth-of-type(${siblings.indexOf(n) + 1})`);
      if (unique(parts.join(' > '))) return parts.join(' > ');
    }
    throw new Error('无法定位店铺名称');
  }
  const validName = name => name.length >= 2 && name.length <= 60 && !/[\n\r]/.test(name) &&
    !/^(店铺|账号|账户|登录|首页|我的店铺|店铺名称|全部店铺|当前店铺|店铺管理|店铺信息|商家后台)$/.test(name) &&
    !/切换|退出|登录|请选择|加载中|帮助中心|查看全部/.test(name);
  function detect(previous) {
    // A manual override remains valid only while the exact visible element still matches.
    if (previous?.source === 'manual') {
      try {
        const found = [...document.querySelectorAll(previous.selector)].filter(visible);
        if (found.length === 1 && C.compact(found[0].innerText) === C.compact(previous.matchText || previous.name)) return previous;
      } catch { /* Continue to automatic detection. */ }
    }
    const candidates = [];
    for (const el of document.querySelectorAll('span,a,div,strong,p,h1,h2')) {
      if (!visible(el)) continue;
      const rect = el.getBoundingClientRect();
      if (rect.top < 0 || rect.top > 180 || rect.bottom > 240) continue;
      const text = C.normalize(el.innerText);
      const name = text.replace(/^(?:当前)?店铺(?:名称)?\s*[:：]\s*/, '');
      if (!validName(name)) continue;
      const identityNodes = [el, el.parentElement, el.parentElement?.parentElement].filter(n => n && C.compact(n.innerText) === C.compact(text));
      const attrs = identityNodes.map(n => [n.id, n.className, n.getAttribute('data-testid'), n.getAttribute('data-test')].join(' ').trim()).join(' ');
      const semantic = /(?:shop|mall|store)[\s_-]*name|(?:shop|mall|store)Name|^(?:shop|mall|store)$/.test(attrs.trim()) ||
        identityNodes.some(n => ['data-shop-name', 'data-mall-name', 'data-store-name'].some(key => n.hasAttribute(key)));
      const inHeader = !!el.closest('header,[role="banner"],[class*="header"],[class*="Header"]');
      const right = rect.left > innerWidth * .45;
      const suffix = /(?:旗舰店|专营店|专卖店|企业店|个人店|商店|网店|小店|店铺|门店)$/.test(name);
      if (!semantic && !(right && suffix && !el.closest('main,#pdd-app-skeleton-main-content'))) continue;
      if (el.children.length && [...el.children].some(child => visible(child) && C.normalize(child.innerText) === text)) continue;
      candidates.push({ name, matchText: text, selector: selectorFor(el), source: 'auto',
        score: (semantic ? 100 : 0) + (inHeader ? 20 : 0) + (right ? 10 : 0) });
    }
    const byName = new Map();
    for (const candidate of candidates.sort((a, b) => b.score - a.score)) if (!byName.has(candidate.name)) byName.set(candidate.name, candidate);
    const ranked = [...byName.values()];
    if (!ranked.length) return { error: '暂未识别到当前店铺。页面加载后会自动重试，也可手动选择一次店铺名称。' };
    if (ranked.length > 1) return { error: '页面中出现多个店铺名称，请关闭切店菜单后重试，或手动选择当前店铺。' };
    const { score, ...binding } = ranked[0];
    return binding;
  }
  globalThis.PddShop = { detect, selectorFor };
})();
