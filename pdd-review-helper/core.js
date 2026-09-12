/* Shared domain logic. No browser or network dependencies. */
(function (root) {
  'use strict';
  const normalize = value => String(value ?? '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
  const compact = value => normalize(value).replace(/\s/g, '');
  const chinaDay = time => new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(new Date(time));
  const stableKey = record => JSON.stringify([
    record.shopKey, record.reviewId || '', record.orderId, record.productId,
    record.reviewTime, record.kind || 'main'
  ]);
  function normalizeCriteria(input = {}) {
    const date = input.date || '近30天';
    if (!['近30天', '近90天', '近180天'].includes(date)) throw new Error('请选择近30天、近90天或近180天');
    const stars = [...new Set(input.stars ?? [1, 2, 3])].sort((a, b) => a - b);
    if (!stars.length || stars.some(n => !Number.isInteger(n) || n < 1 || n > 5)) throw new Error('请至少选择一个有效星级');
    const content = [...new Set(input.content || [])];
    if (content.some(label => !['有图片', '有视频', '主评有文字', '有追加评价', '已举报'].includes(label))) throw new Error('评价内容筛选无效');
    const reply = input.reply || '不限';
    if (!['不限', '已回复', '未回复'].includes(reply)) throw new Error('商家回复筛选无效');
    const criteria = { date, stars, content, reply, reward: !!input.reward, tag: normalize(input.tag).slice(0, 50),
      orderId: normalize(input.orderId).slice(0, 80), productId: normalize(input.productId).slice(0, 80), keyword: normalize(input.keyword).slice(0, 200) };
    if (criteria.orderId && !/^[\d-]+$/.test(criteria.orderId)) throw new Error('订单编号只应包含数字和横线');
    if (criteria.productId && !/^\d+$/.test(criteria.productId)) throw new Error('商品ID只应包含数字');
    return criteria;
  }
  function newTask(binding, now = Date.now()) {
    return {
      schema: 1, id: `${now}-${Math.random().toString(36).slice(2, 10)}`,
      shop: { ...binding }, startedAt: now, day: chinaDay(now), updatedAt: now,
      status: 'ready', message: '准备扫描', currentStar: 1, currentPage: 0,
      attempt: 0, completedStars: [], countsByStar: {}, records: [], events: [],
      completeness: 'unverified', submittedCount: 0, criteria: normalizeCriteria()
    };
  }
  function reportState(actionText, hasEnabledReport) {
    const text = compact(actionText);
    if (/已举报|举报成功|举报处理中|举报审核中|举报已提交|查看举报/.test(text)) return 'reported';
    if (hasEnabledReport) return 'available';
    return 'unknown';
  }
  function mergeRecords(existing, incoming, now = Date.now()) {
    const map = new Map(existing.map(r => [r.key || stableKey(r), { ...r }]));
    for (const candidate of incoming) {
      const key = stableKey(candidate);
      const old = map.get(key);
      if (old && (compact(old.content) !== compact(candidate.content) || old.stars !== candidate.stars)) {
        map.set(key, { ...old, conflict: true, latestObservation: { ...candidate }, lastSeenAt: now });
      } else {
        map.set(key, {
          ...candidate, key, firstSeenAt: old?.firstSeenAt || now, lastSeenAt: now,
          review: old?.review || { status: 'pending', reason: '', facts: '', evidence: '', checkedAt: null },
          reportPreparation: old?.reportPreparation, reportBatchResult: old?.reportBatchResult,
          conflict: old?.conflict || false
        });
      }
    }
    return [...map.values()];
  }
  function stats(task) {
    const rows = (task?.records || []).filter(r => r.inCurrentScope !== false);
    return {
      total: rows.length, reported: rows.filter(r => r.reportState === 'reported').length,
      available: rows.filter(r => r.reportState === 'available').length,
      unknown: rows.filter(r => r.reportState === 'unknown').length,
      noText: rows.filter(r => r.contentType === 'no_text').length,
      conflicts: rows.filter(r => r.conflict).length,
      verified: rows.filter(r => r.review?.status === 'verified').length,
      pending: rows.filter(r => !r.review || r.review.status === 'pending').length
    };
  }
  const csvCell = value => {
    let text = String(value ?? '');
    // Text beginning with formula markers must remain inert in Excel/WPS.
    if (/^[\s]*[=+@\-]/.test(text) || /^[\t\r]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const csv = rows => '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
  const reportLabels = { reported: '已举报', available: '有举报入口', unknown: '状态不明' };
  const reviewLabels = { pending: '待核验', verified: '已核验（未提交）', excluded: '不举报' };
  function exportCsv(task) {
    return csv([
      ['任务ID', '店铺标识', '店铺名称', '订单编号', '商品ID', '评价时间', '星级', '内容分类',
        '评价内容', '举报状态', '核验状态', '拟选原因', '事实说明', '证据备注', '内容冲突', '扫描状态', '本轮范围'],
      ...task.records.map(r => [task.id, r.shopKey, task.shop.name, r.orderId, r.productId,
        r.reviewTime, r.stars, r.contentType === 'no_text' ? '无文字评价' : '有文字评价',
        r.content, reportLabels[r.reportState], reviewLabels[r.review?.status || 'pending'],
        r.review?.reason, r.review?.facts, r.review?.evidence, r.conflict ? '需复核' : '', task.completeness,
        r.inCurrentScope === false ? '历史记录（本轮未发现）' : '本轮记录'])
    ]);
  }
  function validateReview(record, review) {
    if (!['pending', 'verified', 'excluded'].includes(review.status)) throw new Error('未知核验状态');
    if (review.status === 'verified') {
      if (record.conflict) throw new Error('该条内容存在冲突，请先通过原页面核实；本版不允许直接确认冲突记录');
      if (record.reportState !== 'available') throw new Error('只有明确存在举报入口的记录可进入核验完成状态');
      if (!['评价内容异常', '星级与内容矛盾', '利用评价要挟', '同行恶意差评'].includes(review.reason)) throw new Error('请选择真实适用的原因');
      if (compact(review.facts).length < 20) throw new Error('请填写至少20字的具体事实');
      if (['利用评价要挟', '同行恶意差评'].includes(review.reason) && compact(review.evidence).length < 5) throw new Error('请填写对应证据的具体位置或说明，不能由是否有文字推断');
      if (!review.attested) throw new Error('请确认本条说明来自实际核实的事实');
    }
    return {
      status: review.status, reason: normalize(review.reason).slice(0, 100),
      facts: normalize(review.facts).slice(0, 5000), evidence: normalize(review.evidence).slice(0, 2000),
      attested: !!review.attested, checkedAt: Date.now()
    };
  }
  function normalizeAccountMap(input) {
    if (input?.format !== 'pdd-account-map-v1' || !Array.isArray(input.rows) || !input.rows.length || input.rows.length > 5000) throw new Error('请选择店铺行号映射JSON文件');
    const source = normalize(input.source), sheet = normalize(input.sheet);
    if (!source || source.length > 200 || !sheet || sheet.length > 31) throw new Error('账号表文件名或工作表无效');
    const seen = new Set();
    const rows = input.rows.map(item => {
      const name = normalize(item.name), row = item.row;
      if (!name || name.length > 150 || !Number.isInteger(row) || row < 2 || row > 1048576 || seen.has(row)) throw new Error('店铺名称或表格行号无效、重复');
      seen.add(row); return { name, row };
    });
    // Keep only the name/row allowlist; credentials and arbitrary imported fields are discarded.
    return { format: 'pdd-account-map-v1', source, sheet, rows };
  }
  function matchAccount(map, name) {
    if (!map) return { status: 'missing' };
    const matches = map.rows.filter(row => normalize(row.name) === normalize(name));
    if (!matches.length) return { status: 'unmatched' };
    if (matches.length > 1) return { status: 'ambiguous' };
    return { status: 'matched', source: map.source, sheet: map.sheet, row: matches[0].row };
  }
  function batchCandidates(task) {
    const seen = new Set();
    return (task?.records || []).filter(record => {
      if (!record.key || seen.has(record.key) || record.shopKey !== task.shop.shopKey ||
          record.inCurrentScope === false || record.review?.status !== 'verified' || compact(record.review.evidence).length < 5) return false;
      try { validateReview(record, record.review); } catch { return false; }
      seen.add(record.key); return true;
    });
  }
  const batchItemLabels = { pending: '待处理', locating: '正在定位', waiting_manual: '等待平台手动提交', unconfirmed: '结果待确认',
    confirmed_reported: '已确认平台显示已举报', skipped_reported: '原已举报，跳过', skipped_type_disabled: '类型不可用，跳过',
    skipped_unavailable: '入口不可用，跳过', skipped_manual: '用户跳过', not_found: '未找到，待核对' };
  function newBatch(task, now = Date.now()) {
    const rows = batchCandidates(task);
    if (!rows.length) throw new Error('没有可批量处理的评价；请先保存已核验事实和至少5字的证据说明');
    return { id: `${now}-${Math.random().toString(36).slice(2, 10)}`, status: 'running', cursor: 0, createdAt: now, updatedAt: now,
      message: '批量队列已创建', items: rows.map(row => ({ key: row.key, state: 'pending', message: '待处理' })) };
  }
  function batchStats(batch) {
    const items = batch?.items || [], terminal = items.filter(item => ['confirmed_reported', 'skipped_reported', 'skipped_type_disabled', 'skipped_unavailable', 'skipped_manual', 'not_found'].includes(item.state));
    return { total: items.length, done: terminal.length, confirmed: items.filter(item => item.state === 'confirmed_reported').length,
      skipped: terminal.filter(item => item.state.startsWith('skipped_')).length, unresolved: items.filter(item => ['unconfirmed', 'not_found'].includes(item.state)).length };
  }
  function exportBatchCsv(task) {
    return csv([['批次ID', '店铺名称', '订单编号', '星级', '举报类型', '处理状态', '说明', '更新时间'],
      ...(task.batch?.items || []).map(item => { const row = task.records.find(r => r.key === item.key); return [task.batch.id, task.shop.name,
        row?.orderId, row?.stars, row?.review?.reason, batchItemLabels[item.state] || item.state, item.message, item.updatedAt ? new Date(item.updatedAt).toISOString() : '']; })]);
  }
  root.PddCore = { normalize, compact, chinaDay, stableKey, newTask, reportState, mergeRecords,
    stats, csvCell, csv, exportCsv, validateReview, reportLabels, reviewLabels, normalizeCriteria, normalizeAccountMap, matchAccount,
    batchCandidates, newBatch, batchStats, batchItemLabels, exportBatchCsv };
  if (typeof module !== 'undefined') module.exports = root.PddCore;
})(globalThis);
