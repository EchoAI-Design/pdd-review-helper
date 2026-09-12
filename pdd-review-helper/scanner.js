(function (root) {
  'use strict';
  const C = root.PddCore;
  class ScanRunner {
    constructor(adapter, save, onProgress = () => {}) {
      this.adapter = adapter; this.save = save; this.onProgress = onProgress;
      this.requested = null; this.running = false;
    }
    control(command) { this.requested = command; }
    async run(task) {
      if (this.running) throw new Error('该页面已有扫描任务');
      this.running = true; this.requested = null;
      const guard = async () => {
        if (this.requested) { const e = new Error(this.requested === 'stop' ? '扫描已停止，已采集数据保留' : '扫描已暂停，进度已保留'); e.code = this.requested; throw e; }
        if (C.chinaDay(Date.now()) !== task.day) { const e = new Error('日期已变化，请新建任务重新确定近30天范围'); e.code = 'DAY_CHANGED'; throw e; }
      };
      const persist = async () => {
        task.updatedAt = Date.now();
        await this.save(task); this.onProgress(task);
      };
      const event = message => {
        task.events.push({ at: Date.now(), message });
        task.events = task.events.slice(-200); task.message = message;
      };
      this.adapter.onWait = async message => {
        event(`正在读取${task.currentStar}星查询结果：${message}`); await persist();
      };
      try {
        await guard(); this.adapter.assertShop();
        task.criteria = C.normalizeCriteria(task.criteria);
        this.adapter.configure?.(task.criteria);
        task.attempt++; task.status = 'running'; task.completeness = 'unverified';
        task.completedStars = []; task.countsByStar = {};
        event('开始扫描；恢复时从各星级第1页复核并合并已有记录'); await persist();
        for (const star of task.criteria.stars) {
          await guard(); task.currentStar = star; task.currentPage = 0;
          event(`正在查询${task.criteria.date}的${star}星评价`); await persist();
          let page = await this.adapter.queryStar(star, guard);
          const expectedTotal = page.total;
          if (expectedTotal >= 2000) throw Object.assign(new Error('该星级结果达到2000条展示边界，无法确认完整性。此版本需缩小范围后另行适配扫描。'), { code: 'RESULT_CAP' });
          const seen = new Set(), pages = new Set();
          while (true) {
            await guard(); this.adapter.assertShop();
            if (page.total !== expectedTotal) throw new Error('扫描期间结果总数发生变化，已停止；继续会从第1页重新核对');
            if (pages.has(page.signature)) throw new Error('检测到重复页面，已停止以防循环或漏扫');
            pages.add(page.signature);
            for (const row of page.rows) {
              if (row.shopKey !== task.shop.shopKey || row.stars !== star) throw new Error('店铺或星级校验失败');
              const key = C.stableKey(row);
              if (seen.has(key)) throw new Error('不同页出现重复评价，列表可能重排；请重新扫描');
              seen.add(key);
            }
            task.records = C.mergeRecords(task.records, page.rows);
            task.currentPage = page.page;
            task.countsByStar[star] = { expected: expectedTotal, observed: seen.size, complete: false };
            event(`${star}星 · 第${page.page}页 · 已核对${seen.size}/${expectedTotal}条`); await persist();
            if (page.last) break;
            if (page.page >= 250) throw new Error('页数超过本版限制，已停止');
            page = await this.adapter.next(page, star, guard);
          }
          if (seen.size !== expectedTotal) throw new Error(`已到末页，但${star}星只获取${seen.size}/${expectedTotal}条，不能标记完整`);
          // Old records are retained but excluded from current scope when no longer present.
          task.records = task.records.map(r => r.stars === star ? { ...r, inCurrentScope: seen.has(r.key) } : r);
          task.countsByStar[star].complete = true; task.completedStars.push(star);
          event(`${star}星核对完成，共${seen.size}条`); await persist();
        }
        const conflicts = task.records.filter(r => r.inCurrentScope !== false && r.conflict).length;
        task.status = conflicts ? 'needs_attention' : 'completed';
        task.completeness = conflicts ? 'conflicts' : 'complete';
        event(conflicts ? '查询结束，但有内容冲突需要核实' : `${task.criteria.stars.join('、')}星查询完成；所有分页数量已核对，未执行举报`);
      } catch (e) {
        task.status = e.code === 'pause' ? 'paused' : e.code === 'stop' ? 'stopped' : 'needs_attention';
        task.completeness = 'incomplete'; task.errorCode = e.code || 'SCAN_ERROR'; event(e.message);
      } finally {
        try { await persist(); }
        finally { this.running = false; }
      }
      return task;
    }
  }
  root.PddScanRunner = ScanRunner;
  if (typeof module !== 'undefined') module.exports = ScanRunner;
})(globalThis);
