/**
 * Float Todo App — Renderer
 * 浅色系 · 浅粉+薄荷绿 · 长期事项 · 周诊断报告
 */

(function () {
  'use strict';

  // ── 状态 ──────────────────────────────────────────────────────────────────
  let todos = {};           // { 'YYYY-MM-DD': [...], __longterm__: [...] }
  let currentDate = todayStr();
  let currentFilter = 'all';
  let currentView = 'daily';   // 'daily' | 'longterm'
  let ltFilter = 'all';        // 'all' | 'ongoing' | 'done'
  let isCollapsed = false;
  let isLocked = false;  // 锁定位置：true=不可拖动，false=可拖动
  let currentTheme = 'default'; // 'default' | 'mono'
  let saveTimer = null;

  // ── 工具 ──────────────────────────────────────────────────────────────────
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function offsetDate(dateStr, days) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + days);
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  }

  function formatDateLabel(dateStr) {
    const today = todayStr();
    const d = new Date(dateStr + 'T00:00:00');
    const weekdays = ['周日','周一','周二','周三','周四','周五','周六'];
    const wd = weekdays[d.getDay()];
    if (dateStr === today) return `今天 · ${wd}`;
    if (dateStr === offsetDate(today, -1)) return `昨天 · ${wd}`;
    if (dateStr === offsetDate(today, 1))  return `明天 · ${wd}`;
    const diff = Math.round(
      (new Date(dateStr+'T00:00:00') - new Date(today+'T00:00:00')) / 86400000
    );
    if (diff > 1 && diff <= 6)  return `${diff} 天后 · ${wd}`;
    if (diff < -1 && diff >= -6) return `${Math.abs(diff)} 天前 · ${wd}`;
    return `${d.getMonth()+1}月${d.getDate()}日 · ${wd}`;
  }

  function formatDateFull(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return `${d.getFullYear()} 年 ${d.getMonth()+1} 月 ${d.getDate()} 日`;
  }

  function genId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function getTodos(date) { return todos[date] || []; }

  function getLongterm() { return todos.__longterm__ || []; }

  function escHtml(str) {
    return str
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function setText(id, val) {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  }

  // ── 数据持久化 ────────────────────────────────────────────────────────────
  async function loadData() {
    try {
      const data = await window.electronAPI.getData();
      if (data && typeof data === 'object') todos = data;
    } catch (e) { console.error('loadData:', e); }
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      window.electronAPI.saveTodos(todos).catch(console.error);
    }, 300);
  }

  // ── 主渲染入口 ────────────────────────────────────────────────────────────
  function render() {
    if (currentView === 'daily') {
      renderDateNav();
      renderStats();
      renderList();
    } else {
      renderLongterm();
    }
    renderWindowSize();
  }

  // ── 窗口尺寸自适应 ────────────────────────────────────────────────────────
  function renderWindowSize() {
    if (isCollapsed) {
      window.electronAPI.setWindowSize(54, 54);
    } else {
      const app = document.getElementById('app');
      if (app) {
        const h = Math.min(Math.max(app.scrollHeight + 2, 320), 680);
        window.electronAPI.setWindowSize(380, h);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  每日待办
  // ══════════════════════════════════════════════════════════════════════════

  function renderDateNav() {
    const today = todayStr();
    const labelEl = document.getElementById('date-label');
    const fullEl  = document.getElementById('date-full');
    if (labelEl) {
      labelEl.textContent = formatDateLabel(currentDate);
      labelEl.className = 'date-label' + (currentDate === today ? ' today' : '');
    }
    if (fullEl) fullEl.textContent = formatDateFull(currentDate);
  }

  function renderStats() {
    const list  = getTodos(currentDate);
    const total = list.length;
    const done  = list.filter(t => t.done).length;
    const pct   = total > 0 ? Math.round((done / total) * 100) : 0;
    setText('stat-total', total);
    setText('stat-done', done);
    setText('stat-pct', pct + '%');
    const fill = document.getElementById('progress-fill');
    if (fill) {
      fill.style.width = pct + '%';
      fill.classList.toggle('has-progress', pct > 0 && pct < 100);
    }
  }

  function renderList() {
    const listEl  = document.getElementById('todo-list');
    const emptyEl = document.getElementById('empty-state');
    if (!listEl) return;
    let items = getTodos(currentDate);
    if (currentFilter === 'pending') items = items.filter(t => !t.done);
    else if (currentFilter === 'done') items = items.filter(t => t.done);
    listEl.innerHTML = '';
    if (items.length === 0) {
      emptyEl && emptyEl.classList.add('show');
    } else {
      emptyEl && emptyEl.classList.remove('show');
      items.forEach(todo => listEl.appendChild(createDailyItem(todo)));
    }
  }

  function createDailyItem(todo) {
    const li = document.createElement('li');
    li.className = 'todo-item' + (todo.done ? ' done' : '');
    li.dataset.id = todo.id;
    if (todo.priority && todo.priority !== 'none') li.dataset.priority = todo.priority;

    const priorityLabel = { high: '高', medium: '中', low: '低' };
    const priorityBadge = (todo.priority && todo.priority !== 'none')
      ? `<span class="todo-priority-badge ${todo.priority}">${priorityLabel[todo.priority]}</span>` : '';
    const timeBadge = todo.time
      ? `<span class="todo-time"><span class="todo-time-icon">⏰</span>${todo.time}</span>` : '';
    const metaHtml = (priorityBadge || timeBadge)
      ? `<div class="todo-meta">${timeBadge}${priorityBadge}</div>` : '';

    li.innerHTML = `
      <div class="todo-check" data-id="${todo.id}"><span class="check-mark">✓</span></div>
      <div class="todo-content">
        <div class="todo-text" contenteditable="true" data-id="${todo.id}" spellcheck="false">${escHtml(todo.text)}</div>
        ${metaHtml}
      </div>
      <div class="todo-actions">
        <button class="action-btn del" data-id="${todo.id}" title="删除">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>`;

    li.querySelector('.todo-check').addEventListener('click', e => {
      e.stopPropagation(); toggleTodo(todo.id);
    });

    const textEl = li.querySelector('.todo-text');
    textEl.addEventListener('blur', () => {
      const t = textEl.textContent.trim();
      if (t && t !== todo.text) updateTodoText(todo.id, t);
      else if (!t) textEl.textContent = todo.text;
    });
    textEl.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); textEl.blur(); }
      if (e.key === 'Escape') { textEl.textContent = todo.text; textEl.blur(); }
    });

    li.querySelector('.action-btn.del').addEventListener('click', e => {
      e.stopPropagation();
      li.classList.add('removing');
      li.addEventListener('animationend', () => deleteTodo(todo.id), { once: true });
    });

    return li;
  }

  // 每日待办数据操作
  function addTodo(text, priority, time) {
    if (!text.trim()) return;
    if (!todos[currentDate]) todos[currentDate] = [];
    todos[currentDate].push({
      id: genId(), text: text.trim(), done: false,
      priority: priority || 'none', time: time || '',
      createdAt: Date.now(),
    });
    scheduleSave(); render();
  }

  function toggleTodo(id) {
    const todo = getTodos(currentDate).find(t => t.id === id);
    if (todo) { todo.done = !todo.done; scheduleSave(); render(); }
  }

  function deleteTodo(id) {
    if (todos[currentDate]) {
      todos[currentDate] = todos[currentDate].filter(t => t.id !== id);
      scheduleSave(); render();
    }
  }

  function updateTodoText(id, newText) {
    const todo = getTodos(currentDate).find(t => t.id === id);
    if (todo) { todo.text = newText; scheduleSave(); }
  }

  function clearDone() {
    if (todos[currentDate]) {
      todos[currentDate] = todos[currentDate].filter(t => !t.done);
      scheduleSave(); render();
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  长期事项
  // ══════════════════════════════════════════════════════════════════════════

  function renderLongterm() {
    const all   = getLongterm();
    const total = all.length;
    const done  = all.filter(t => t.done).length;
    const pct   = total > 0 ? Math.round((done / total) * 100) : 0;

    setText('lt-badge', total - done);
    setText('lt-stat-total', total + ' 项');
    setText('lt-stat-done', done + ' 已完成');

    const fill = document.getElementById('lt-progress-fill');
    if (fill) {
      fill.style.width = pct + '%';
      fill.classList.toggle('has-progress', pct > 0 && pct < 100);
    }

    const listEl  = document.getElementById('lt-list');
    const emptyEl = document.getElementById('lt-empty-state');
    if (!listEl) return;

    let items = [...all];
    if (ltFilter === 'ongoing') items = items.filter(t => !t.done);
    else if (ltFilter === 'done') items = items.filter(t => t.done);

    listEl.innerHTML = '';
    if (items.length === 0) {
      emptyEl && emptyEl.classList.add('show');
    } else {
      emptyEl && emptyEl.classList.remove('show');
      items.forEach(item => listEl.appendChild(createLongtermItem(item)));
    }
  }

  function createLongtermItem(item) {
    const li = document.createElement('li');
    li.className = 'todo-item' + (item.done ? ' done' : '');
    li.dataset.id = item.id;
    if (item.priority && item.priority !== 'none') li.dataset.priority = item.priority;

    const priorityLabel = { high: '高', medium: '中', low: '低' };
    const priorityBadge = (item.priority && item.priority !== 'none')
      ? `<span class="todo-priority-badge ${item.priority}">${priorityLabel[item.priority]}</span>` : '';
    const tagBadge = item.tag
      ? `<span class="lt-item-tag">${escHtml(item.tag)}</span>` : '';
    const metaHtml = (priorityBadge || tagBadge)
      ? `<div class="todo-meta">${tagBadge}${priorityBadge}</div>` : '';

    li.innerHTML = `
      <div class="todo-check" data-id="${item.id}"><span class="check-mark">✓</span></div>
      <div class="todo-content">
        <div class="todo-text" contenteditable="true" data-id="${item.id}" spellcheck="false">${escHtml(item.text)}</div>
        ${metaHtml}
      </div>
      <div class="todo-actions">
        <button class="action-btn del" data-id="${item.id}" title="删除">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>
      </div>`;

    li.querySelector('.todo-check').addEventListener('click', e => {
      e.stopPropagation(); toggleLongterm(item.id);
    });

    const textEl = li.querySelector('.todo-text');
    textEl.addEventListener('blur', () => {
      const t = textEl.textContent.trim();
      if (t && t !== item.text) updateLongtermText(item.id, t);
      else if (!t) textEl.textContent = item.text;
    });
    textEl.addEventListener('keydown', e => {
      if (e.key === 'Enter')  { e.preventDefault(); textEl.blur(); }
      if (e.key === 'Escape') { textEl.textContent = item.text; textEl.blur(); }
    });

    li.querySelector('.action-btn.del').addEventListener('click', e => {
      e.stopPropagation();
      li.classList.add('removing');
      li.addEventListener('animationend', () => deleteLongterm(item.id), { once: true });
    });

    return li;
  }

  function addLongterm(text, priority, tag) {
    if (!text.trim()) return;
    if (!todos.__longterm__) todos.__longterm__ = [];
    todos.__longterm__.push({
      id: genId(), text: text.trim(), done: false,
      priority: priority || 'none', tag: tag || '',
      createdAt: Date.now(),
    });
    scheduleSave(); render();
  }

  function toggleLongterm(id) {
    const item = getLongterm().find(t => t.id === id);
    if (item) { item.done = !item.done; scheduleSave(); render(); }
  }

  function deleteLongterm(id) {
    if (todos.__longterm__) {
      todos.__longterm__ = todos.__longterm__.filter(t => t.id !== id);
      scheduleSave(); render();
    }
  }

  function updateLongtermText(id, newText) {
    const item = getLongterm().find(t => t.id === id);
    if (item) { item.text = newText; scheduleSave(); }
  }

  function clearLongtermDone() {
    if (todos.__longterm__) {
      todos.__longterm__ = todos.__longterm__.filter(t => !t.done);
      scheduleSave(); render();
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  周诊断报告
  // ══════════════════════════════════════════════════════════════════════════

  function getWeekDates() {
    const today = new Date(todayStr() + 'T00:00:00');
    const day = today.getDay(); // 0=周日
    // 本周一到今天（含）
    const monday = new Date(today);
    monday.setDate(today.getDate() - (day === 0 ? 6 : day - 1));
    const dates = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday);
      d.setDate(monday.getDate() + i);
      dates.push(`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`);
    }
    return dates;
  }

  function buildWeekReport() {
    const weekDates = getWeekDates();
    const weekLabels = ['周一','周二','周三','周四','周五','周六','周日'];
    const today = todayStr();

    let totalAll = 0, totalDone = 0;
    const dayStats = weekDates.map((date, i) => {
      const list = getTodos(date);
      const all  = list.length;
      const done = list.filter(t => t.done).length;
      totalAll  += all;
      totalDone += done;
      return { label: weekLabels[i], date, all, done, isFuture: date > today };
    });

    // 精力分布（按优先级统计本周所有任务）
    const energyCount = { high: 0, medium: 0, low: 0, none: 0 };
    weekDates.forEach(date => {
      getTodos(date).forEach(t => {
        energyCount[t.priority || 'none']++;
      });
    });

    // 最忙一天
    const busiest = [...dayStats].filter(d => !d.isFuture).sort((a,b) => b.all - a.all)[0];
    // 完成率最高一天
    const bestDay = [...dayStats]
      .filter(d => !d.isFuture && d.all > 0)
      .sort((a,b) => (b.done/b.all) - (a.done/a.all))[0];

    const weekPct = totalAll > 0 ? Math.round((totalDone / totalAll) * 100) : 0;

    // 诊断建议
    const insights = [];
    if (weekPct >= 80) insights.push('本周完成率优秀，执行力很强！');
    else if (weekPct >= 50) insights.push('本周完成率良好，还有提升空间。');
    else if (totalAll === 0) insights.push('本周尚未添加任何任务，试着规划一下吧。');
    else insights.push('本周完成率偏低，建议减少任务数量，聚焦核心事项。');

    if (energyCount.high > energyCount.medium + energyCount.low) {
      insights.push('高优先级任务占比较高，注意精力分配，避免过载。');
    }
    if (busiest && busiest.all >= 5) {
      insights.push(`${busiest.label}（${busiest.date}）任务最多，共 ${busiest.all} 项。`);
    }
    if (bestDay) {
      const pct = Math.round((bestDay.done / bestDay.all) * 100);
      insights.push(`完成率最高是${bestDay.label}，达到 ${pct}%，状态最佳。`);
    }

    // ── 事项分析（语义归类 + 定性总结）────────────────────────────────────
    // 收集本周所有非未来任务
    const allItems = [];
    weekDates.forEach((date, i) => {
      getTodos(date).forEach(t => {
        allItems.push({ ...t, dateLabel: weekLabels[i], date, isFuture: date > today });
      });
    });
    const pastItems = allItems.filter(t => !t.isFuture);

    // ── 归类规则：关键词 → 类别 ──────────────────────────────────────────
    const CATEGORY_RULES = [
      {
        id: 'work',
        label: '工作 / 项目',
        icon: '💼',
        keywords: ['会议','需求','评审','上线','发布','排期','方案','文档','报告','汇报',
                   'PRD','设计','开发','测试','联调','review','meeting','task','project',
                   'bug','fix','deploy','code','接口','迭代','sprint','复盘','对齐','沟通'],
      },
      {
        id: 'learn',
        label: '学习 / 成长',
        icon: '📚',
        keywords: ['学习','阅读','看书','读书','笔记','总结','研究','调研','了解','熟悉',
                   '练习','实践','课程','培训','分享','输出','写作','blog','文章','整理'],
      },
      {
        id: 'life',
        label: '生活 / 事务',
        icon: '🏠',
        keywords: ['买','购','超市','快递','快递','家','打扫','整理','收拾','预约','挂号',
                   '缴费','还款','银行','保险','快递','外卖','吃饭','聚餐','旅行','出行'],
      },
      {
        id: 'health',
        label: '健康 / 运动',
        icon: '🏃',
        keywords: ['运动','健身','跑步','锻炼','瑜伽','游泳','骑车','散步','体检','医院',
                   '睡眠','休息','饮食','减肥','打卡','步数'],
      },
      {
        id: 'social',
        label: '社交 / 沟通',
        icon: '💬',
        keywords: ['联系','回复','消息','电话','拜访','约','朋友','家人','同事','客户',
                   '跟进','反馈','确认','沟通','协调'],
      },
    ];

    // 对每条任务打标签（可多标签，取第一个匹配）
    function classifyItem(text) {
      const t = text.toLowerCase();
      for (const cat of CATEGORY_RULES) {
        if (cat.keywords.some(kw => t.includes(kw.toLowerCase()))) return cat.id;
      }
      return 'other';
    }

    // 按类别分组
    const groups = {};
    CATEGORY_RULES.forEach(c => { groups[c.id] = { ...c, items: [] }; });
    groups['other'] = { id: 'other', label: '其他事项', icon: '📌', items: [] };

    pastItems.forEach(t => {
      const catId = classifyItem(t.text);
      groups[catId].items.push(t);
    });

    // 只保留有内容的类别，按数量排序
    const activeGroups = Object.values(groups)
      .filter(g => g.items.length > 0)
      .sort((a, b) => b.items.length - a.items.length);

    // ── 对每个类别生成定性总结 ───────────────────────────────────────────
    function summarizeGroup(g) {
      const total = g.items.length;
      const done  = g.items.filter(t => t.done).length;
      const pct   = total > 0 ? Math.round((done / total) * 100) : 0;
      const highCount = g.items.filter(t => t.priority === 'high').length;
      const pending   = g.items.filter(t => !t.done);

      // 反复推迟检测
      const pendingMap = {};
      pending.forEach(t => {
        const key = t.text.trim().slice(0, 20);
        pendingMap[key] = (pendingMap[key] || 0) + 1;
      });
      const deferredCount = Object.values(pendingMap).filter(c => c >= 2).length;

      // 定性描述
      const parts = [];

      // 完成情况
      if (total === 0) {
        parts.push('本周无相关事项。');
      } else if (pct === 100) {
        parts.push(`共 ${total} 项，全部完成，执行到位。`);
      } else if (pct >= 70) {
        parts.push(`共 ${total} 项，完成 ${done} 项（${pct}%），整体推进顺畅。`);
      } else if (pct >= 40) {
        parts.push(`共 ${total} 项，完成 ${done} 项（${pct}%），仍有 ${total - done} 项待跟进。`);
      } else if (done === 0) {
        parts.push(`共 ${total} 项，本周均未完成，建议重新评估优先级或拆解任务。`);
      } else {
        parts.push(`共 ${total} 项，完成率偏低（${pct}%），需关注执行阻力。`);
      }

      // 高优占比
      if (highCount > 0) {
        const highPct = Math.round((highCount / total) * 100);
        if (highPct >= 60) {
          parts.push(`高优任务占比 ${highPct}%，精力投入较集中，注意避免过载。`);
        } else {
          parts.push(`含 ${highCount} 项高优任务。`);
        }
      }

      // 反复推迟
      if (deferredCount > 0) {
        parts.push(`有 ${deferredCount} 项事项被反复推迟，建议拆解或重新排期。`);
      }

      return { total, done, pct, summary: parts.join(' ') };
    }

    const itemAnalysis = {
      activeGroups: activeGroups.map(g => ({
        ...g,
        ...summarizeGroup(g),
      })),
      totalItems: pastItems.length,
    };

    return { dayStats, energyCount, totalAll, totalDone, weekPct, insights, weekDates, itemAnalysis };
  }

  function renderReport() {
    const { dayStats, energyCount, totalAll, totalDone, weekPct, insights, itemAnalysis } = buildWeekReport();
    const body = document.getElementById('report-body');
    if (!body) return;

    const maxDay = Math.max(...dayStats.map(d => d.all), 1);
    const energyTotal = Object.values(energyCount).reduce((a,b) => a+b, 0) || 1;

    const energyRows = [
      { key: 'high',   label: '🔴 高优先级', cls: 'high' },
      { key: 'medium', label: '🟡 中优先级', cls: 'medium' },
      { key: 'low',    label: '🟢 低优先级', cls: 'low' },
      { key: 'none',   label: '⚪ 无优先级', cls: 'none' },
    ];

    body.innerHTML = `
      <!-- 总览 -->
      <div class="report-section">
        <div class="report-section-title">本周总览</div>
        <div class="report-overview">
          <div class="report-ov-card">
            <div class="report-ov-num pink">${totalAll}</div>
            <div class="report-ov-lbl">总任务</div>
          </div>
          <div class="report-ov-card">
            <div class="report-ov-num mint">${totalDone}</div>
            <div class="report-ov-lbl">已完成</div>
          </div>
          <div class="report-ov-card">
            <div class="report-ov-num lavender">${weekPct}%</div>
            <div class="report-ov-lbl">完成率</div>
          </div>
        </div>
      </div>

      <!-- 每日分布 -->
      <div class="report-section">
        <div class="report-section-title">每日分布</div>
        ${dayStats.map(d => `
          <div class="report-day-row">
            <div class="report-day-label">${d.label}</div>
            <div class="report-day-bar-wrap">
              <div class="report-day-bar" style="width:${d.all > 0 ? Math.round((d.all/maxDay)*100) : 0}%"></div>
            </div>
            <div class="report-day-nums"><span>${d.done}</span>/${d.all}</div>
          </div>`).join('')}
      </div>

      <!-- 精力分配 -->
      <div class="report-section">
        <div class="report-section-title">精力分配</div>
        ${energyRows.map(r => `
          <div class="report-energy-row">
            <div class="report-energy-label">${r.label}</div>
            <div class="report-energy-bar-wrap">
              <div class="report-energy-bar ${r.cls}" style="width:${Math.round((energyCount[r.key]/energyTotal)*100)}%"></div>
            </div>
            <div class="report-energy-pct">${Math.round((energyCount[r.key]/energyTotal)*100)}%</div>
          </div>`).join('')}
      </div>

      <!-- 诊断建议 -->
      <div class="report-section">
        <div class="report-section-title">诊断建议</div>
        <div class="report-insight">
          ${insights.map((s,i) => i === 0 ? `<strong>${s}</strong>` : s).join('<br>')}
        </div>
      </div>

      <!-- 事项分析 -->
      <div class="report-section">
        <div class="report-section-title">事项分析</div>
        ${itemAnalysis.activeGroups.length === 0 ? `
          <div class="report-insight" style="text-align:center;color:var(--t-faint);">本周暂无足够数据进行事项分析</div>
        ` : itemAnalysis.activeGroups.map(g => `
          <div class="report-cat-card">
            <div class="report-cat-header">
              <span class="report-cat-icon">${g.icon}</span>
              <span class="report-cat-label">${g.label}</span>
              <div class="report-cat-meta">
                <span class="report-cat-pct ${g.pct === 100 ? 'full' : g.pct >= 60 ? 'good' : 'low'}">${g.pct}%</span>
                <span class="report-cat-count">${g.done}/${g.total}</span>
              </div>
            </div>
            <div class="report-cat-bar-wrap">
              <div class="report-cat-bar" style="width:${g.pct}%"></div>
            </div>
            <div class="report-cat-summary">${g.summary}</div>
            <div class="report-cat-items">
              ${g.items.slice(0, 4).map(t => `
                <span class="report-cat-item ${t.done ? 'done' : ''} ${t.priority !== 'none' ? t.priority : ''}">
                  ${t.done ? '✓' : '·'} ${escHtml(t.text.length > 16 ? t.text.slice(0, 16) + '…' : t.text)}
                </span>`).join('')}
              ${g.items.length > 4 ? `<span class="report-cat-more">+${g.items.length - 4} 项</span>` : ''}
            </div>
          </div>`).join('')}
      </div>
    `;
  }

  function buildReportText() {
    const { dayStats, energyCount, totalAll, totalDone, weekPct, insights } = buildWeekReport();
    const weekLabels = ['周一','周二','周三','周四','周五','周六','周日'];
    const energyTotal = Object.values(energyCount).reduce((a,b)=>a+b,0)||1;
    let text = `📊 本周待办诊断报告\n`;
    text += `${'─'.repeat(24)}\n`;
    text += `总任务 ${totalAll} · 已完成 ${totalDone} · 完成率 ${weekPct}%\n\n`;
    text += `📅 每日分布\n`;
    dayStats.forEach((d,i) => {
      const bar = '█'.repeat(Math.round((d.all/Math.max(...dayStats.map(x=>x.all),1))*8));
      text += `${weekLabels[i]}  ${bar||'·'}  ${d.done}/${d.all}\n`;
    });
    text += `\n⚡ 精力分配\n`;
    const eMap = {high:'高优先级',medium:'中优先级',low:'低优先级',none:'无优先级'};
    Object.entries(energyCount).forEach(([k,v]) => {
      text += `${eMap[k]}  ${Math.round((v/energyTotal)*100)}%（${v} 项）\n`;
    });
    text += `\n💡 诊断建议\n`;
    insights.forEach(s => { text += `• ${s}\n`; });

    // 事项分析（定性归类）
    const { itemAnalysis } = buildWeekReport();
    text += `\n📋 事项分析\n`;
    if (itemAnalysis.activeGroups.length === 0) {
      text += `本周暂无足够数据进行事项分析\n`;
    } else {
      itemAnalysis.activeGroups.forEach(g => {
        text += `\n${g.icon} ${g.label}（${g.done}/${g.total} 完成，${g.pct}%）\n`;
        text += `  ${g.summary}\n`;
        g.items.slice(0, 4).forEach(t => {
          text += `  ${t.done ? '✓' : '·'} ${t.text}\n`;
        });
        if (g.items.length > 4) text += `  … 另有 ${g.items.length - 4} 项\n`;
      });
    }
    return text;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  拖拽
  // ══════════════════════════════════════════════════════════════════════════

  function initDrag() {
    const titlebar = document.getElementById('titlebar');
    if (!titlebar) return;
    let dragging = false, lastX = 0, lastY = 0;
    titlebar.addEventListener('mousedown', e => {
      if (e.target.closest('.tb-btn') || e.target.closest('.view-tabs') || e.target.closest('.export-btn')) return;
      if (isCollapsed || isLocked) return;
      dragging = true; lastX = e.screenX; lastY = e.screenY;
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      const dx = e.screenX - lastX, dy = e.screenY - lastY;
      lastX = e.screenX; lastY = e.screenY;
      if (dx !== 0 || dy !== 0) window.electronAPI.dragWindow(dx, dy);
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  事件绑定
  // ══════════════════════════════════════════════════════════════════════════

  function bindEvents() {
    // ── 视图切换 Tab ──
    document.querySelectorAll('.view-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        currentView = tab.dataset.view;
        document.querySelectorAll('.view-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById('panel-daily').classList.toggle('hidden', currentView !== 'daily');
        document.getElementById('panel-longterm').classList.toggle('hidden', currentView !== 'longterm');
        render();
        if (currentView === 'daily') {
          setTimeout(() => document.getElementById('todo-input')?.focus(), 80);
        } else {
          setTimeout(() => document.getElementById('lt-input')?.focus(), 80);
        }
      });
    });

    // ── 折叠 ──
    document.getElementById('btn-collapse')?.addEventListener('click', () => {
      isCollapsed = true;
      document.body.classList.add('collapsed');
      renderWindowSize();
    });
    document.getElementById('titlebar')?.addEventListener('click', e => {
      if (isCollapsed && !e.target.closest('.tb-btn')) {
        isCollapsed = false;
        document.body.classList.remove('collapsed');
        renderWindowSize();
      }
    });

    // ── 关闭 / 位置锁定 ──
    document.getElementById('btn-close')?.addEventListener('click', () => window.electronAPI.hideWindow());
    const pinBtn = document.getElementById('btn-pin');
    // 初始化：未锁定状态
    if (pinBtn) {
      pinBtn.classList.remove('pinned');
      pinBtn.title = '锁定位置';
    }
    pinBtn?.addEventListener('click', () => {
      isLocked = !isLocked;
      pinBtn.classList.toggle('pinned', isLocked);
      pinBtn.title = isLocked ? '解锁位置' : '锁定位置';
      // 锁定时标题栏改为不可拖动的视觉提示
      const titlebar = document.getElementById('titlebar');
      if (titlebar) titlebar.style.cursor = isLocked ? 'default' : 'grab';
    });

    // ── 日期导航 ──
    document.getElementById('btn-prev')?.addEventListener('click', () => { currentDate = offsetDate(currentDate, -1); render(); });
    document.getElementById('btn-next')?.addEventListener('click', () => { currentDate = offsetDate(currentDate, 1);  render(); });
    document.getElementById('btn-today')?.addEventListener('click', () => { currentDate = todayStr(); render(); });
    document.getElementById('btn-clear-done')?.addEventListener('click', clearDone);

    // ── 每日添加 ──
    const input       = document.getElementById('todo-input');
    const addBtn      = document.getElementById('btn-add');
    const prioritySel = document.getElementById('priority-sel');
    const timeInput   = document.getElementById('time-input');

    function doAdd() {
      const text = input?.value?.trim();
      if (!text) {
        input?.classList.add('shake');
        input?.addEventListener('animationend', () => input.classList.remove('shake'), { once: true });
        return;
      }
      addTodo(text, prioritySel?.value, timeInput?.value);
      if (input) input.value = '';
      if (prioritySel) prioritySel.value = 'none';
      if (timeInput) timeInput.value = '';
      input?.focus();
    }

    input?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });
    addBtn?.addEventListener('click', doAdd);

    // ── 每日筛选 ──
    document.querySelectorAll('.filter-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        currentFilter = tab.dataset.filter;
        document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        renderList();
      });
    });

    // ── 长期添加 ──
    const ltInput       = document.getElementById('lt-input');
    const ltAddBtn      = document.getElementById('lt-btn-add');
    const ltPrioritySel = document.getElementById('lt-priority-sel');
    const ltTagInput    = document.getElementById('lt-tag-input');

    function doAddLt() {
      const text = ltInput?.value?.trim();
      if (!text) {
        ltInput?.classList.add('shake');
        ltInput?.addEventListener('animationend', () => ltInput.classList.remove('shake'), { once: true });
        return;
      }
      addLongterm(text, ltPrioritySel?.value, ltTagInput?.value?.trim());
      if (ltInput) ltInput.value = '';
      if (ltPrioritySel) ltPrioritySel.value = 'none';
      if (ltTagInput) ltTagInput.value = '';
      ltInput?.focus();
    }

    ltInput?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doAddLt(); } });
    ltAddBtn?.addEventListener('click', doAddLt);

    // ── 长期筛选 ──
    document.querySelectorAll('.lt-cat-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        ltFilter = btn.dataset.cat;
        document.querySelectorAll('.lt-cat-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderLongterm();
      });
    });

    document.getElementById('lt-btn-clear-done')?.addEventListener('click', clearLongtermDone);

    // ── 周报导出 ──
    document.getElementById('btn-export')?.addEventListener('click', () => {
      renderReport();
      document.getElementById('report-overlay')?.classList.remove('hidden');
    });

    function closeReport() {
      document.getElementById('report-overlay')?.classList.add('hidden');
    }

    document.getElementById('report-close')?.addEventListener('click', closeReport);
    document.getElementById('report-close-btn')?.addEventListener('click', closeReport);
    document.getElementById('report-overlay')?.addEventListener('click', e => {
      if (e.target === document.getElementById('report-overlay')) closeReport();
    });

    document.getElementById('report-copy')?.addEventListener('click', () => {
      const text = buildReportText();
      navigator.clipboard.writeText(text).then(() => {
        const btn = document.getElementById('report-copy');
        if (btn) { btn.textContent = '已复制 ✓'; setTimeout(() => { btn.textContent = '复制文本'; }, 1800); }
      }).catch(() => {
        // fallback
        const ta = document.createElement('textarea');
        ta.value = buildReportText();
        document.body.appendChild(ta);
        ta.select(); document.execCommand('copy');
        document.body.removeChild(ta);
      });
    });

    // ── 主题切换 ──
    document.getElementById('btn-theme')?.addEventListener('click', () => {
      currentTheme = currentTheme === 'default' ? 'mono' : 'default';
      applyTheme(currentTheme);
      localStorage.setItem('float-todo-theme', currentTheme);
    });
  }

  // ── 主题应用 ──────────────────────────────────────────────────────────────
  function applyTheme(theme) {
    const app = document.getElementById('app');
    const btn = document.getElementById('btn-theme');
    if (!app) return;
    if (theme === 'mono') {
      app.dataset.theme = 'mono';
      btn?.classList.add('active');
      btn?.setAttribute('title', '切换主题：当前简约黑白');
    } else {
      delete app.dataset.theme;
      btn?.classList.remove('active');
      btn?.setAttribute('title', '切换主题：当前浅粉薄荷');
    }
  }

  // ── 初始化 ────────────────────────────────────────────────────────────────
  async function init() {
    await loadData();
    // 恢复主题
    const savedTheme = localStorage.getItem('float-todo-theme');
    if (savedTheme === 'mono') { currentTheme = 'mono'; applyTheme('mono'); }
    initDrag();
    bindEvents();
    render();
    setTimeout(() => document.getElementById('todo-input')?.focus(), 120);
  }

  init().catch(console.error);

})();
