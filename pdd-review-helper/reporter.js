/* One user-verified record at a time. Never clicks the platform submit button. */
(() => {
  const C = PddCore, sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  class ReportPreparer {
    constructor(adapter, progress = async () => {}) { this.adapter = adapter; this.progress = progress; }
    modal() {
      const all = [...document.querySelectorAll('[role="dialog"],[class*="modal" i]')].filter(el => this.adapter.visible(el) &&
        /举报/.test(this.adapter.text(el)) && /详细描述|举报类型|举报原因/.test(this.adapter.text(el)));
      return all.find(el => !all.some(other => other !== el && el.contains(other)));
    }
    async run(record, criteria, guard = async () => {}) {
      if (record.review?.status !== 'verified' || record.inCurrentScope === false) throw new Error('请先逐条保存事实与证据核验结果');
      C.validateReview(record, record.review);
      const adapter = this.adapter; adapter.configure(criteria); adapter.assertShop();
      await this.progress('正在定位所选评价，重新核对当前举报状态');
      let page;
      try { page = adapter.readPage(record.stars); } catch { /* Query from page 1 below. */ }
      let target = page?.rows.find(r => C.stableKey(r) === record.key);
      if (!target) page = await adapter.queryStar(record.stars, guard);
      const total = page.total, visited = new Set();
      if (total >= 2000) throw new Error('查询达到展示上限，请先缩小条件定位该评价');
      while (true) {
        await guard(); adapter.assertShop();
        if (page.total !== total || visited.has(page.signature)) throw new Error('定位期间列表变化或重复，请重新查询后核验');
        visited.add(page.signature);
        const index = page.rows.findIndex(r => C.stableKey(r) === record.key);
        if (index >= 0) {
          target = page.rows[index];
          if (C.compact(target.content) !== C.compact(record.content) || target.stars !== record.stars) throw new Error('评价内容或星级发生变化，请重新核验');
          if (target.reportState === 'reported') return { status: 'skipped_reported', message: '平台显示这条评价已举报，已跳过' };
          if (target.reportState !== 'available') return { status: 'skipped_unavailable', message: '这条评价当前没有可用举报入口，已跳过' };
          const card = adapter.tables()[index];
          const rows = [...card.querySelectorAll('tr')].filter(tr => tr.cells.length >= 3);
          const actions = rows[rows.length - 1]?.lastElementChild;
          const button = adapter.one('举报', actions);
          await adapter.click(button, guard);
          break;
        }
        if (page.last) return { status: 'not_found', message: '当前查询中没有找到这条评价，请重新查询后核验' };
        if (visited.size >= 200) throw new Error('定位页数达到上限');
        await this.progress(`正在定位评价：${record.stars}星，第${page.page + 1}页`);
        page = await adapter.next(page, record.stars, guard);
      }
      let modal;
      for (let i = 0; i < 40; i++) {
        await guard(); adapter.assertShop({ allowModal: true }); modal = this.modal();
        if (modal) break; await sleep(150);
      }
      if (!modal) return { status: 'manual_needed', message: '已点击该评价的举报入口，弹窗结构尚未识别，请在平台手动核对' };
      const choices = adapter.exact(record.review.reason, modal);
      if (choices.length !== 1) return { status: 'manual_needed', message: '弹窗没有唯一匹配的已核验举报类型，请在平台核对；未选择其他类型' };
      const choice = choices[0];
      const radioContainer = choice.closest('label,[role="radio"]') || choice.parentElement;
      const disabled = adapter.isDisabled(choice) || !!radioContainer?.querySelector('input[disabled]');
      if (disabled) {
        const closes = [...modal.querySelectorAll('[aria-label="关闭"],[title="关闭"]')].filter(el => adapter.visible(el));
        const close = closes[0] || adapter.exact('取消', modal)[0] || adapter.exact('关闭', modal)[0];
        if (close && !adapter.isDisabled(close)) { await guard(); close.click(); }
        return { status: 'skipped_type_disabled', message: close ? '已核验的举报类型当前不可用，已关闭弹窗并跳过' : '已核验的举报类型当前不可用，已跳过；请手动关闭弹窗' };
      }
      await guard(); adapter.assertShop({ allowModal: true }); choice.click(); await sleep(180);
      const chosen = adapter.selected(choice) || !!radioContainer?.querySelector('input:checked');
      if (!chosen) return { status: 'manual_needed', message: '无法确认举报类型选中状态，请在平台核对；未填写描述' };
      const descriptions = [...modal.querySelectorAll('textarea')].filter(el => adapter.visible(el) && !adapter.isDisabled(el));
      if (descriptions.length !== 1) return { status: 'manual_needed', message: '无法唯一识别详细描述输入框，请手动填写已核验事实' };
      if (descriptions[0].maxLength >= 0 && record.review.facts.length > descriptions[0].maxLength) return { status: 'manual_needed', message: '已核验说明超过平台字数上限，请缩短事实说明后重新核验' };
      await guard(); adapter.assertShop({ allowModal: true }); adapter.setField(descriptions[0], record.review.facts);
      if (descriptions[0].value !== record.review.facts) throw new Error('平台描述输入校验失败，请手动核对');
      return { status: 'prepared', message: '已填写本条已核验的类型和事实；请在平台核对、上传对应证据并手动提交。尚未计入举报条数' };
    }
  }
  globalThis.PddReportPreparer = ReportPreparer;
})();
