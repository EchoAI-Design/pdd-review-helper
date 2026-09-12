/* DOM-only PDD adapter. Fail closed on ambiguous or unsupported page layouts. */
(function (root) {
  'use strict';
  const C = root.PddCore;
  const RATING_LABEL = /用户(?:评价得分|评价分|评分)\s*[:：]?/;
  const ORDER_LABEL = /订单(?:编号|号码|号)\s*[:：]\s*([\d-]+)/;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  class PageError extends Error {
    constructor(message, code = 'PAGE_UNSUPPORTED') { super(message); this.code = code; }
  }
  class PddAdapter {
    constructor(binding, options = {}) {
      this.binding = binding;
      this.options = { timeout: 18000, stableFor: 1000, poll: 180, ...options };
      this.selectors = binding?.selectors || {};
      this.criteria = C.normalizeCriteria();
    }
    configure(criteria) { this.criteria = C.normalizeCriteria(criteria); }
    visible(el) {
      return !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden' &&
        getComputedStyle(el).display !== 'none' && !el.closest('[data-pdd-helper]');
    }
    text(el) { return C.normalize(el?.innerText ?? el?.textContent ?? ''); }
    contentRoot() {
      return document.querySelector(this.selectors.root || '#pdd-app-skeleton-main-content, main') || document.body;
    }
    exact(text, scope = this.contentRoot()) {
      const hits = [...scope.querySelectorAll('button,a,span,div,label,li')].filter(el =>
        this.visible(el) && C.compact(this.text(el)) === C.compact(text));
      return hits.filter(el => !hits.some(other => other !== el && el.contains(other)));
    }
    one(text, scope) {
      const hits = this.exact(text, scope);
      if (hits.length !== 1) throw new PageError(`无法唯一定位“${text}”（找到${hits.length}个）。请保持评价列表打开，关闭其他弹窗。`);
      return hits[0];
    }
    isDisabled(el) {
      if (!el) return true;
      for (let node = el, depth = 0; node && depth < 5; node = node.parentElement, depth++) {
        if (node.matches('[disabled],[aria-disabled="true"],[data-disabled="true"]') ||
          /(^|[\s_-])disabled([\s_-]|$)/i.test(String(node.className?.baseVal || node.className || ''))) return true;
      }
      return false;
    }
    async click(el, guard) {
      await guard(); this.assertShop();
      if (!this.visible(el) || this.isDisabled(el)) throw new PageError('目标控件已失效或不可用');
      el.click();
    }
    assertShop({ allowModal = false } = {}) {
      if (!location.pathname.startsWith('/goods/evaluation/')) throw new PageError('请打开拼多多「评价管理 → 评价列表」', 'NAVIGATION');
      if (!this.binding?.selector || !this.binding?.name) throw new PageError('请先绑定页面右上角显示当前店铺名称的元素', 'SHOP_UNBOUND');
      let elements;
      try { elements = [...document.querySelectorAll(this.binding.selector)].filter(el => this.visible(el)); }
      catch { throw new PageError('店铺定位规则无效，请重新绑定'); }
      if (elements.length !== 1 || C.compact(this.text(elements[0])) !== C.compact(this.binding.matchText || this.binding.name)) {
        throw new PageError('当前店铺名称与任务绑定不一致，或名称元素已改变。请检查店铺后重新绑定。', 'SHOP_CHANGED');
      }
      const modal = [...document.querySelectorAll('[role="dialog"],.ant-modal-wrap')].find(el => this.visible(el));
      if (modal && !allowModal) throw new PageError('页面有未关闭的弹窗，请先关闭后继续', 'MODAL_OPEN');
      const risk = this.exact('请完成安全验证').length || this.exact('请完成验证').length;
      if (risk) throw new PageError('页面要求验证，请在浏览器中手动完成', 'VERIFICATION');
    }
    selected(el) {
      for (let n = el, depth = 0; n && depth < 3; n = n.parentElement, depth++) {
        if (n.matches('[aria-checked="true"],[aria-selected="true"],input:checked')) return true;
        if (/(^|[\s_-])(selected|active|checked)([\s_-]|$)/i.test(String(n.className || ''))) return true;
        // PDD's text chips may expose selected state only through blue text/background.
        const color = getComputedStyle(n).color.match(/\d+/g)?.map(Number);
        if (color && color[2] > 130 && color[2] > color[0] * 1.3 && color[2] > color[1] * 1.12) return true;
      }
      return false;
    }
    assertFilters(star) {
      if (!this.selected(this.one(this.criteria.date))) throw new PageError(`无法确认“${this.criteria.date}”已选中，已停止，避免扫描错误日期`);
      const selected = [1, 2, 3, 4, 5].filter(n => this.selected(this.one(`${n}星`)));
      if (selected.length !== 1 || selected[0] !== star) throw new PageError('无法确认只选中了目标星级，已停止');
      for (const label of this.criteria.content) if (!this.selected(this.one(label))) throw new PageError(`无法确认“${label}”筛选已选中`);
      if (this.criteria.reply !== '不限' && !this.selected(this.one(this.criteria.reply))) throw new PageError('商家回复筛选未生效');
      if (this.criteria.reward && !this.selected(this.one('评价有礼'))) throw new PageError('评价有礼筛选未生效');
      if (this.criteria.tag && !this.selected(this.tagControl(this.criteria.tag))) throw new PageError('评价标签筛选未生效');
      for (const [key, labels] of this.inputFields()) {
        const input = this.fieldInput(labels);
        if (input && input.value !== this.criteria[key]) throw new PageError(`${labels[0]}查询条件与插件不一致`);
        if (!input && this.criteria[key]) throw new PageError(`无法读取${labels[0]}查询条件`);
      }
    }
    inputFields() { return [['orderId', ['订单编号', '订单号']], ['productId', ['商品ID']], ['keyword', ['关键词']]]; }
    fieldInput(labels) {
      for (const label of labels) for (const hit of this.exact(label)) {
        for (let node = hit.parentElement, depth = 0; node && depth < 4; node = node.parentElement, depth++) {
          const inputs = [...node.querySelectorAll('input:not([type="checkbox"]):not([type="radio"]):not([type="hidden"]),textarea')].filter(el => this.visible(el));
          if (inputs.length === 1) return inputs[0];
          if (inputs.length > 1) break;
        }
      }
      return null;
    }
    setField(input, value) {
      const proto = input.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    tagOptions() {
      const query = this.exact('查询')[0];
      if (!query) return [];
      const candidates = [...this.contentRoot().querySelectorAll('a,span,button,div')].filter(el => this.visible(el) &&
        !!(el.compareDocumentPosition(query) & Node.DOCUMENT_POSITION_FOLLOWING) && /^.{1,30}[(（][\d,]+[)）]$/.test(this.text(el)));
      return candidates.filter(el => !candidates.some(other => other !== el && el.contains(other))).map(el => ({
        value: this.text(el).replace(/[(（][\d,]+[)）]$/, ''), label: this.text(el), element: el
      }));
    }
    tagControl(value) {
      const hits = this.tagOptions().filter(t => C.compact(t.value) === C.compact(value));
      if (hits.length !== 1) throw new PageError('当前页面没有唯一匹配的评价标签，请重新查询或重置标签条件');
      return hits[0].element;
    }
    tables() {
      const all = [...this.contentRoot().querySelectorAll(this.selectors.card || 'table,tbody')]
        .filter(el => this.visible(el) && RATING_LABEL.test(this.text(el)) && ORDER_LABEL.test(this.text(el)));
      return all.filter(el => !all.some(other => other !== el && el.contains(other)));
    }
    count() {
      const text = this.text(this.contentRoot());
      const m = text.match(/(?:共查询到|共查到|共找到|共搜索到)\s*([\d,，]+)\s*条/);
      if (!m) throw new PageError('未识别到“共查询到…条”结果统计，请确认页面已加载');
      return Number(m[1].replace(/[,，]/g, ''));
    }
    busy() {
      return [...this.contentRoot().querySelectorAll('[aria-busy="true"],.ant-spin-spinning,[class*="loading"]')]
        .some(el => this.visible(el) && !el.matches('button'));
    }
    rating(card) {
      const header = card.querySelector('tr') || card;
      // Limit icon recognition to the score region, before likes/interactions.
      const range = document.createRange(); range.selectNodeContents(header);
      const walker = document.createTreeWalker(header, NodeFilter.SHOW_TEXT);
      let node, started = false;
      while ((node = walker.nextNode())) {
        if (!started) {
          const match = node.textContent.match(RATING_LABEL);
          if (!match) continue;
          range.setStart(node, match.index + match[0].length); started = true;
          const rest = node.textContent.slice(match.index + match[0].length).search(/被点赞数|点赞数|互动数/);
          if (rest >= 0) { range.setEnd(node, match.index + match[0].length + rest); break; }
        } else {
          const index = node.textContent.search(/被点赞数|点赞数|互动数/);
          if (index >= 0) { range.setEnd(node, index); break; }
        }
      }
      const inScore = el => this.visible(el) && (!started || range.intersectsNode(el));
      if (this.selectors.rating) {
        const nodes = [...header.querySelectorAll(this.selectors.rating)].filter(el => this.visible(el));
        if (nodes.length >= 1 && nodes.length <= 5) return nodes.length;
      }
      const numeric = header.querySelector('[data-rating],[aria-valuenow]');
      const n = Number(numeric?.getAttribute('data-rating') || numeric?.getAttribute('aria-valuenow'));
      if (Number.isInteger(n) && n >= 1 && n <= 5) return n;
      const aria = [...header.querySelectorAll('[aria-label]')].map(el => el.getAttribute('aria-label')).join(' ');
      const explicit = (this.text(header) + ' ' + aria).match(/(?:用户(?:评价得分|评价分|评分)\s*[:：]?\s*|评分\s*[:：]?\s*)([1-5])(?:\s*星|\s*分|\s|$)/);
      if (explicit) return Number(explicit[1]);
      const full = [...header.querySelectorAll('.ant-rate-star-full,[class*="rate-star-full"],[class*="star_full"],[class*="star-full"]')].filter(inScore);
      if (full.length >= 1 && full.length <= 5) return full.length;
      // Count every visible star text node, including stars separated by spans or
      // whitespace. range.toString() includes hidden text and /★+/ only counts
      // the first contiguous run, incorrectly making a 2/3-star review one star.
      const texts = [], scoreWalker = document.createTreeWalker(header, NodeFilter.SHOW_TEXT);
      while ((node = scoreWalker.nextNode())) {
        if (!this.visible(node.parentElement) || (started && !range.intersectsNode(node))) continue;
        let value = node.textContent;
        const start = started && node === range.startContainer ? range.startOffset : 0;
        const end = started && node === range.endContainer ? range.endOffset : value.length;
        value = value.slice(start, end);
        texts.push({ value, element: node.parentElement });
      }
      const unicode = texts.reduce((count, item) => count + (item.value.match(/★/g)?.length || 0), 0);
      if (unicode >= 1 && unicode <= 5) return unicode;
      const red = value => {
        const rgb = String(value).match(/[\d.]+/g)?.map(Number);
        return rgb?.length >= 3 && (rgb.length < 4 || rgb[3] > 0) && rgb[0] > 150 && rgb[0] > rgb[1] * 1.4 && rgb[0] > rgb[2] * 1.4;
      };
      const glyphs = texts.filter(item => /^[\s\uE000-\uF8FF]+$/.test(item.value) && red(getComputedStyle(item.element).color))
        .reduce((count, item) => count + (item.value.match(/[\uE000-\uF8FF]/g)?.length || 0), 0);
      if (glyphs >= 1 && glyphs <= 5) return glyphs;
      // PDD also renders the star as an unnamed red SVG path or icon-font glyph.
      const candidates = [...header.querySelectorAll('svg,i,span')].filter(el => {
        if (!inScore(el)) return false;
        const named = /star/i.test(`${el.className?.baseVal || el.className || ''} ${el.getAttribute('data-icon') || ''}`);
        if (el.tagName.toLowerCase() === 'svg') {
          const paints = [...el.querySelectorAll('path,polygon,use')];
          return paints.length > 0 && paints.length <= 2 && paints.some(p => red(getComputedStyle(p).fill));
        }
        const glyph = /^[\uE000-\uF8FF★]$/.test(el.textContent.trim());
        return (named || glyph) && red(getComputedStyle(el).color);
      });
      const leaves = candidates.filter(el => !candidates.some(other => other !== el && el.contains(other)));
      if (leaves.length >= 1 && leaves.length <= 5) return leaves.length;
      throw new PageError('无法从评价卡片验证星级。请导出页面诊断，适配后再扫描；不会用筛选条件代替实际评分。');
    }
    parseCard(card) {
      const whole = this.text(card);
      const orderId = whole.match(ORDER_LABEL)?.[1];
      const productId = whole.match(/(?:商品\s*)?ID\s*[:：]\s*(\d+)/i)?.[1];
      const detailRows = [...card.querySelectorAll('tr')].filter(tr => tr.cells.length >= 3 && ORDER_LABEL.test(this.text(tr)));
      if (detailRows.length > 1) throw new PageError('多个评价共用同一表格，尚不能逐条分组，请导出页面诊断');
      const row = detailRows[0];
      const detail = row?.cells[0];
      const actions = row?.cells[row.cells.length - 1];
      if (!orderId || !productId || !detail || !actions) throw new PageError('评价卡片结构不匹配（订单、商品或明细列缺失）');
      const detailText = this.text(detail);
      const reviewTime = detailText.match(/\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}(?::\d{2})?/)?.[0];
      if (!reviewTime) throw new PageError('评价缺少可识别的时间');
      const content = C.normalize(detailText.replace(reviewTime, ''));
      if (!content) throw new PageError('评价内容为空且没有“未填写文字评价”标识，请检查页面');
      const reportButtons = this.exact('举报', actions);
      return {
        shopKey: this.binding.shopKey,
        reviewId: card.getAttribute('data-review-id') || card.getAttribute('data-comment-id') || '',
        orderId, productId, reviewTime, stars: this.rating(card), kind: 'main', content,
        contentType: C.compact(content) === '该用户未填写文字评价' ? 'no_text' : 'text',
        reportState: C.reportState(this.text(actions), reportButtons.some(el => !this.isDisabled(el))),
        actionText: this.text(actions), hasImage: !!detail.querySelector('img'), hasVideo: !!detail.querySelector('video'),
        sourceUrl: location.origin + location.pathname
      };
    }
    pagination() {
      const candidates = [...this.contentRoot().querySelectorAll(this.selectors.pagination || 'ul,[class*="pagination" i],[aria-label*="分页"]')].filter(el => this.visible(el));
      // A valid scope must contain BOTH current page and next control. A page-size
      // label by itself must never win over the enclosing pagination widget.
      for (const scope of candidates.reverse()) {
        const explicit = [...scope.querySelectorAll(this.selectors.currentPage || '[aria-current="page"],[class*="active" i],[class*="selected" i]')]
          .filter(el => this.visible(el) && /^\d+$/.test(this.text(el)));
        const active = explicit.length ? explicit : [...scope.querySelectorAll('a,span,li,button')]
          .filter(el => this.visible(el) && /^\d+$/.test(this.text(el)) && this.selected(el));
        const pages = [...new Set(active.map(el => Number(this.text(el))))];
        if (pages.length !== 1 || pages[0] < 1) continue;
        const named = [...scope.querySelectorAll(this.selectors.nextPage || '[title="下一页"],[aria-label="下一页"],[rel="next"]')].filter(el => this.visible(el));
        const nexts = named.length ? named : [...scope.querySelectorAll('[class*="next" i]')].filter(el => this.visible(el) &&
          !/jump|quick|last|end|more|prev/i.test(String(el.className?.baseVal || el.className || '')));
        const nextControls = nexts.filter(el => !nexts.some(other => other !== el && other.contains(el)));
        const next = nextControls.length === 1 ? nextControls[0] : this.exact('下一页', scope)[0];
        if (next) return { page: pages[0], next, last: this.isDisabled(next), scope };
      }
      throw new PageError('无法同时识别分页的当前页码和下一页按钮，请导出页面诊断');
    }
    readPage(star) {
      this.assertShop(); this.assertFilters(star);
      if (this.busy()) throw new PageError('结果仍在加载', 'LOADING');
      const total = this.count();
      const rows = this.tables().map(card => this.parseCard(card));
      if (total === 0) {
        const empty = /暂无数据|暂无评价|没有查询到|没有相关评价|无相关评价/.test(this.text(this.contentRoot()));
        if (rows.length || !empty) throw new PageError('空结果尚未得到页面确认', 'LOADING');
        return { rows: [], total: 0, page: 1, last: true, next: null, signature: `empty-${star}` };
      }
      if (!rows.length) throw new PageError('结果数量大于0，但未找到评价卡片', 'LOADING');
      if (rows.some(r => r.stars !== star)) throw new PageError(`目标为${star}星，但卡片识别为${[...new Set(rows.map(r => r.stars))].join('/')}星；等待结果更新，持续不符请导出页面诊断`, 'FILTER_MISMATCH');
      const pagination = this.pagination();
      const signature = JSON.stringify([total, pagination.page, rows.map(r => [C.stableKey(r), r.content, r.reportState])]);
      return { rows, total, ...pagination, signature };
    }
    watchResults() {
      let changed = false;
      const observer = new MutationObserver(mutations => {
        for (const mutation of mutations) {
          const target = mutation.target.nodeType === Node.ELEMENT_NODE ? mutation.target : mutation.target.parentElement;
          if (target?.closest('[data-pdd-helper]')) continue;
          const nodes = [target, ...mutation.addedNodes, ...mutation.removedNodes].filter(n => n?.nodeType === Node.ELEMENT_NODE);
          if (nodes.some(n => n.matches?.('table,tr,td,[class*="spin"],[class*="pagination"],[aria-busy]') ||
            n.closest?.('table,[class*="spin"],[class*="pagination"]') || n.querySelector?.('table'))) changed = true;
        }
      });
      observer.observe(this.contentRoot(), { childList: true, subtree: true, attributes: true, characterData: true });
      return { get changed() { return changed; }, stop: () => observer.disconnect() };
    }
    async settle(star, guard, before, watch, expectedPage) {
      const deadline = Date.now() + this.options.timeout;
      let last = '', since = Date.now(), error, errorSince = Date.now(), errorText = '', announced = '';
      try {
        while (Date.now() < deadline) {
          await guard(); this.assertShop();
          try {
            const page = this.readPage(star);
            if (expectedPage && page.page !== expectedPage) throw new PageError(`等待第${expectedPage}页，但页面显示第${page.page}页；尚未计入本页`, 'PAGE_MISMATCH');
            const transitioned = before === null || page.signature !== before || watch?.changed;
            if (page.signature !== last) { last = page.signature; since = Date.now(); }
            if (transitioned && Date.now() - since >= this.options.stableFor) return page;
            error = null;
          } catch (e) {
            if (e.code === 'SHOP_CHANGED' || e.code === 'NAVIGATION' || e.code === 'VERIFICATION') throw e;
            error = e; last = ''; since = Date.now();
            if (e.message !== errorText) { errorText = e.message; errorSince = Date.now(); }
          }
          if (error && error.code !== 'LOADING' && errorText !== announced && Date.now() - errorSince > 1200) {
            announced = errorText; await this.onWait?.(errorText);
          }
          await sleep(this.options.poll);
        }
        throw new PageError(error?.message || '等待查询结果更新超时，请检查网络后继续', 'RESULT_TIMEOUT');
      } finally { watch?.stop(); }
    }
    async queryStar(star, guard) {
      this.assertShop();
      await this.click(this.one('重置'), guard);
      // Allow React's reset update to commit before selecting independent chips.
      await sleep(300); await guard();
      const day = this.one(this.criteria.date);
      if (!this.selected(day)) await this.click(day, guard);
      await sleep(150); await guard();
      for (const n of [1, 2, 3, 4, 5]) {
        const chip = this.one(`${n}星`);
        if (n !== star && this.selected(chip)) await this.click(chip, guard);
      }
      if (!this.selected(this.one(`${star}星`))) await this.click(this.one(`${star}星`), guard);
      for (const label of [...this.criteria.content, ...(this.criteria.reply === '不限' ? [] : [this.criteria.reply]), ...(this.criteria.reward ? ['评价有礼'] : [])]) {
        const chip = this.one(label); if (!this.selected(chip)) await this.click(chip, guard);
      }
      if (this.criteria.tag) { const tag = this.tagControl(this.criteria.tag); if (!this.selected(tag)) await this.click(tag, guard); }
      for (const [key, labels] of this.inputFields()) {
        await guard(); const input = this.fieldInput(labels);
        if (input) this.setField(input, this.criteria[key]);
        else if (this.criteria[key]) throw new PageError(`无法定位${labels[0]}输入框`);
      }
      await sleep(150); this.assertFilters(star);
      let before;
      try { before = this.readPage(star).signature; } catch { before = 'not-ready'; }
      const watch = this.watchResults();
      try { await this.click(this.one('查询'), guard); }
      catch (e) { watch.stop(); throw e; }
      return this.settle(star, guard, before, watch, 1);
    }
    async next(page, star, guard) {
      const current = this.readPage(star);
      if (current.signature !== page.signature) throw new PageError('当前列表在翻页前发生变化，请重新扫描这一轮');
      const watch = this.watchResults();
      // Prefer the exact next page number: "jump next" and "last page" controls
      // can also contain next in their CSS class and must never be treated as +1.
      const numbered = this.exact(String(page.page + 1), current.scope);
      if (numbered.length > 1) { watch.stop(); throw new PageError('下一页页码控件有多个候选，请导出页面诊断'); }
      let target = numbered[0] || current.next;
      const clickable = target.closest('button,a,li,[role="button"]');
      if (clickable && current.scope.contains(clickable)) target = clickable;
      try { await this.click(target, guard); }
      catch (e) { watch.stop(); throw e; }
      return this.settle(star, guard, page.signature, watch, page.page + 1);
    }
    diagnostic() {
      const result = { url: location.origin + location.pathname, title: document.title, time: new Date().toISOString(), adapterVersion: 4 };
      try { this.assertShop(); result.shopMatches = true; } catch (e) { result.shopMatches = false; result.shopError = e.message; }
      result.controls = ['近30天', '1星', '2星', '3星', '4星', '5星', '查询', '重置'].map(label => ({ label,
        matches: this.exact(label).length, selected: this.exact(label).map(el => this.selected(el)) }));
      result.cards = this.tables().length;
      try { result.resultTotal = this.count(); } catch (e) { result.countError = e.message; }
      result.cardChecks = this.tables().slice(0, 3).map(card => {
        const header = card.querySelector('tr') || card;
        const metadata = { tag: card.tagName, rows: [...card.querySelectorAll('tr')].map(tr => tr.cells.length),
          icons: [...header.querySelectorAll('svg,i,span')].filter(el => this.visible(el) &&
            (el.matches('svg,i,[class*="star" i]') || /[★\uE000-\uF8FF]/.test(el.textContent))).slice(0, 25).map(el => ({
              tag: el.tagName, class: String(el.className?.baseVal || el.className || '').slice(0, 120),
              color: getComputedStyle(el).color, fill: getComputedStyle(el).fill,
              glyphCodes: [...el.textContent].filter(char => /[★☆\uE000-\uF8FF]/.test(char)).slice(0, 10).map(char => char.codePointAt(0).toString(16)),
              paths: [...el.querySelectorAll('path,polygon,use')].slice(0, 6).map(p => ({ fill: getComputedStyle(p).fill }))
            })) };
        try { const record = this.parseCard(card); return { ...metadata, stars: record.stars, reportState: record.reportState, parsed: true }; }
        catch (e) { return { ...metadata, parsed: false, error: e.message }; }
      });
      try { result.pagination = (({ page, last, next, scope }) => ({ page, last, next: { tag: next.tagName, title: next.getAttribute('title'), aria: next.getAttribute('aria-label'), class: String(next.className).slice(0, 120) }, numericButtons: [...scope.querySelectorAll('a,span,li,button')].map(el => this.text(el)).filter(t => /^\d+$/.test(t)).slice(0, 30) }))(this.pagination()); } catch (e) { result.paginationError = e.message; }
      // Deliberately exclude cookies, storage, page HTML and customer review text.
      return result;
    }
  }
  root.PddAdapter = PddAdapter;
  root.PddPageError = PageError;
})(globalThis);
