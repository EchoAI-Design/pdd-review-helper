/* Sequential verified-review queue. No platform submit button is clicked. */
(() => {
  'use strict';
  const C = PddCore, sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  class BatchReporter {
    constructor(adapter, save, options = {}) {
      this.adapter = adapter; this.save = save; this.options = { poll: 500, waitTimeout: 120000, closeGrace: 5000, ...options };
      this.running = false; this.requested = null;
    }
    control(command) { this.requested = command; }
    async closeModal(preparer, guard) {
      const modal = preparer.modal();
      if (modal) {
        const a = this.adapter;
        const controls = [...modal.querySelectorAll('[aria-label="关闭"],[title="关闭"]'), ...a.exact('取消', modal), ...a.exact('关闭', modal)]
          .filter(el => a.visible(el) && !a.isDisabled(el));
        if (!controls.length) throw new Error('无法关闭当前弹窗，请手动关闭后继续队列');
        await guard(); controls[0].click();
        for (let i = 0; i < 10 && preparer.modal(); i++) { await sleep(this.options.poll); await guard(); }
        if (preparer.modal()) throw new Error('弹窗尚未关闭，已暂停队列');
      }
      this.adapter.assertShop();
    }
    async waitForResult(record, preparer, guard) {
      const deadline = Date.now() + this.options.waitTimeout; let closedAt = null, reportedAt = null;
      while (Date.now() < deadline) {
        await guard();
        if (this.requested === 'skip') {
          this.requested = null; await this.closeModal(preparer, guard);
          return { status: 'skipped_manual', message: '用户跳过当前条；未计作提交成功' };
        }
        if (!preparer.modal()) {
          // A closed dialog is not a receipt. Require the same card, unchanged
          // content/rating, and a stable explicit reported status before advancing.
          let blocked = false;
          try { this.adapter.assertShop(); } catch (e) { if (e.code === 'MODAL_OPEN') blocked = true; else throw e; }
          if (!blocked && !this.adapter.busy()) {
            const rows = this.adapter.tables().map(card => this.adapter.parseCard(card));
            const matches = rows.filter(row => C.stableKey(row) === record.key);
            if (matches.length > 1) throw new Error('当前评价出现重复，无法确认举报结果');
            const fresh = matches[0];
            if (fresh && (fresh.stars !== record.stars || C.compact(fresh.content) !== C.compact(record.content))) throw new Error('评价内容或星级变化，已暂停批量处理');
            if (fresh?.reportState === 'reported') {
              reportedAt ??= Date.now();
              if (Date.now() - reportedAt >= this.options.poll) return { status: 'confirmed_reported', message: '已确认本条平台状态为已举报；不代表审核通过，也不计作插件自动提交' };
            } else {
              reportedAt = null; closedAt ??= Date.now();
              if (Date.now() - closedAt >= this.options.closeGrace) throw new Error('弹窗已关闭，但未确认本条已举报；请核对后继续，或在队列运行时跳过当前条');
            }
          }
        } else { closedAt = null; reportedAt = null; }
        await sleep(this.options.poll);
      }
      throw new Error('等待平台手动提交超时，队列已暂停；请核对当前条后继续批量');
    }
    async run(task) {
      if (this.running) throw new Error('批量队列正在运行');
      this.running = true; this.requested = null;
      const batch = task.batch, adapter = this.adapter;
      const guard = async () => {
        if (['pause', 'stop'].includes(this.requested)) throw Object.assign(new Error(this.requested === 'pause' ? '批量队列已暂停' : '批量队列已停止，进度保留'), { code: this.requested });
        if (C.chinaDay(Date.now()) !== task.day) throw new Error('日期已变化，请核对当前条并重新查询');
        adapter.assertShop({ allowModal: true });
      };
      const persist = async message => {
        batch.message = message; batch.updatedAt = Date.now();
        await this.save(structuredClone(batch));
      };
      const finishItem = async result => {
        const item = batch.items[batch.cursor]; item.state = result.status; item.message = result.message; item.updatedAt = Date.now();
        batch.cursor++; batch.status = 'running'; await persist(`批量 ${batch.cursor}/${batch.items.length}：${result.message}`);
      };
      try {
        adapter.configure(task.criteria); batch.status = 'running'; await guard();
        await persist('正在处理已核验评价队列');
        while (batch.cursor < batch.items.length) {
          await guard();
          const item = batch.items[batch.cursor], record = task.records.find(row => row.key === item.key);
          if (!record || record.inCurrentScope === false || record.review?.status !== 'verified' || C.compact(record.review.evidence).length < 5) throw new Error('队列记录缺少已核验事实或证据，请重新核对');
          if (record.reportState === 'reported') { await finishItem({ status: 'skipped_reported', message: '已记录为平台已举报，跳过' }); continue; }
          C.validateReview(record, record.review);
          const preparer = new PddReportPreparer(adapter, message => persist(`批量 ${batch.cursor + 1}/${batch.items.length}：${message}`));
          if (item.state === 'pending') {
            item.state = 'locating'; item.updatedAt = Date.now(); await persist(`正在定位第${batch.cursor + 1}条`);
            const result = await preparer.run(record, task.criteria, guard);
            if (['skipped_reported', 'skipped_unavailable', 'skipped_type_disabled', 'not_found'].includes(result.status)) {
              if (result.status === 'skipped_type_disabled') await this.closeModal(preparer, guard);
              await finishItem(result); continue;
            }
            item.message = result.message;
            item.state = result.status === 'prepared' ? 'waiting_manual' : 'unconfirmed';
            if (result.status !== 'prepared') throw new Error(result.message);
          } else {
            // Resume uncertain work by observing it; never reopen/re-submit it.
            item.state = 'waiting_manual'; item.message = '恢复时先核对上一条平台结果，不重复打开举报';
          }
          batch.status = 'waiting'; item.updatedAt = Date.now();
          await persist(`第${batch.cursor + 1}/${batch.items.length}条：请在平台核对证据并手动提交；确认已举报后自动处理下一条`);
          await finishItem(await this.waitForResult(record, preparer, guard));
        }
        batch.status = 'completed';
        const stats = C.batchStats(batch);
        await persist(`批量队列处理结束：平台显示已举报${stats.confirmed}条，跳过${stats.skipped}条，待核对${stats.unresolved}条；不代表审核通过`);
      } catch (e) {
        batch.status = e.code === 'pause' ? 'paused' : e.code === 'stop' ? 'stopped' : 'needs_attention';
        const current = batch.items[batch.cursor];
        if (current && ['locating', 'waiting_manual', 'unconfirmed'].includes(current.state)) {
          current.state = 'unconfirmed'; current.message = e.message; current.updatedAt = Date.now();
        }
        await persist(e.message);
      } finally { this.running = false; }
      return batch;
    }
  }
  globalThis.PddBatchReporter = BatchReporter;
})();
