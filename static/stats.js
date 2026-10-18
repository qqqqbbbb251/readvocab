import { api } from "./api.js";
import { escapeHtml, statusLabel } from "./ui.js";

function level(count) {
  if (!count) return 0;
  if (count <= 2) return 1;
  if (count <= 5) return 2;
  if (count <= 9) return 3;
  return 4;
}

function heatmap(days) {
  if (!days.length) return "";
  const first = new Date(`${days[0].date}T00:00:00`);
  const offset = (first.getDay() + 6) % 7;
  const cells = [];
  for (let index = 0; index < offset; index += 1) {
    cells.push('<span class="heat-cell blank"></span>');
  }
  for (const day of days) {
    cells.push(
      `<span class="heat-cell level-${level(day.n)}" title="${day.date} · ${day.n} 个新词"></span>`
    );
  }
  return `<div class="heatmap">${cells.join("")}</div>`;
}

export async function mountStats(view) {
  view.innerHTML = `
    <div class="page-wrap">
      <section class="page-head">
        <div>
          <h1>统计</h1>
          <p class="muted">只看你自己攒下来的数据，不联任何外部账号。</p>
        </div>
      </section>
      <div id="stats-body"><div class="empty-state small"><p>正在读取…</p></div></div>
    </div>`;

  const body = view.querySelector("#stats-body");
  let data;
  try {
    data = await api("/api/stats");
  } catch (error) {
    body.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message)}</p></div>`;
    return;
  }

  const statusRows = ["new", "learning", "known"]
    .map((status) => {
      const count = data.status[status] || 0;
      const percent = data.total ? Math.round((count / data.total) * 100) : 0;
      return `
        <div class="status-row">
          <span class="status-name">${statusLabel(status)}</span>
          <div class="bar"><span class="status-${status}" style="width:${percent}%"></span></div>
          <span class="status-count">${count}</span>
        </div>`;
    })
    .join("");

  const docs = data.by_doc.length
    ? data.by_doc
        .map((doc) => {
          const max = Math.max(...data.by_doc.map((entry) => entry.n), 1);
          const width = Math.round((doc.n / max) * 100);
          return `
            <a class="doc-stat" href="#/read/${doc.id}">
              <span class="doc-stat-title">${escapeHtml(doc.title)}</span>
              <span class="doc-stat-bar"><span style="width:${width}%"></span></span>
              <span class="doc-stat-count">${doc.n}</span>
            </a>`;
        })
        .join("")
    : '<p class="muted">还没有从文档里收录生词。</p>';

  const range = data.days.length
    ? `${data.days[0].date} → ${data.days[data.days.length - 1].date}`
    : "";

  body.innerHTML = `
    <div class="stat-grid">
      <div class="stat-card">
        <span class="stat-value">${data.total}</span>
        <span class="stat-label">累计收录</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">${data.today_new}</span>
        <span class="stat-label">今日新增</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">${data.streak}</span>
        <span class="stat-label">连续天数</span>
      </div>
      <div class="stat-card">
        <span class="stat-value">${data.lookups_week}</span>
        <span class="stat-label">本周查阅</span>
        <span class="stat-sub">今天 ${data.lookups_today} 次</span>
      </div>
    </div>
    <section class="panel">
      <div class="panel-head">
        <h2>最近一年</h2>
        <span class="muted">${range}</span>
      </div>
      ${heatmap(data.days)}
      <div class="heat-legend">
        <span>少</span>
        <span class="heat-cell level-0"></span>
        <span class="heat-cell level-1"></span>
        <span class="heat-cell level-2"></span>
        <span class="heat-cell level-3"></span>
        <span class="heat-cell level-4"></span>
        <span>多</span>
        <span class="legend-gap">本周新增 ${data.week_new} 词</span>
      </div>
    </section>
    <section class="panel">
      <h2>掌握情况</h2>
      <div class="status-list">${statusRows}</div>
    </section>
    <section class="panel">
      <h2>按文档</h2>
      <div class="doc-stats">${docs}</div>
    </section>`;
}
