import { api } from "./api.js";
import { debounce, escapeHtml, fmtDate, speak, statusLabel, toast } from "./ui.js";

const STATUSES = ["new", "learning", "known"];

export async function mountVocab(view) {
  view.innerHTML = `
    <div class="page-wrap">
      <section class="page-head">
        <div>
          <h1>生词本</h1>
          <p class="muted">按原形去重，同一个词的多个语境都会保留。</p>
        </div>
        <div class="total-badge"><span id="vocab-total">0</span><small>累计收录</small></div>
      </section>
      <div class="toolbar-row">
        <div class="seg" id="status-filter">
          <button data-status="all" class="active">全部</button>
          ${STATUSES.map((status) => `<button data-status="${status}">${statusLabel(status)}</button>`).join("")}
        </div>
        <input id="vocab-search" class="search" type="search" placeholder="搜索单词" autocomplete="off">
      </div>
      <div id="vocab-list"></div>
      <div class="load-more-wrap"><button id="load-more" class="btn" hidden>加载更多</button></div>
    </div>`;

  const listEl = view.querySelector("#vocab-list");
  const totalEl = view.querySelector("#vocab-total");
  const loadMore = view.querySelector("#load-more");
  const search = view.querySelector("#vocab-search");
  const filter = view.querySelector("#status-filter");
  const limit = 100;
  const state = { status: "all", q: "", offset: 0, items: [], total: 0, loading: false };

  function statusChip(item, status) {
    return `<button class="chip ${item.status === status ? "active" : ""}" data-status-set="${status}" data-id="${item.id}">${statusLabel(status)}</button>`;
  }

  function card(item) {
    const contexts = (item.contexts || [])
      .map((ctx) => {
        const source = ctx.title
          ? `<a href="#/read/${ctx.doc_id}">${escapeHtml(ctx.title)}</a>`
          : "未关联文档";
        const page = ctx.page ? ` · 第 ${ctx.page} 页` : "";
        return `<blockquote class="context"><p>${escapeHtml(ctx.sentence)}</p><footer>${source}${page}</footer></blockquote>`;
      })
      .join("");
    return `
      <article class="vocab-card">
        <div class="vocab-head">
          <div class="vocab-word">
            <h3>${escapeHtml(item.lemma)}</h3>
            ${item.phonetic ? `<span class="phonetic">/${escapeHtml(item.phonetic)}/</span>` : ""}
            ${item.form && item.form.toLowerCase() !== item.lemma.toLowerCase() ? `<span class="form-note">原文：${escapeHtml(item.form)}</span>` : ""}
            <button class="mini-btn" data-speak="${escapeHtml(item.lemma)}">发音</button>
          </div>
          <div class="vocab-tools">
            <div class="chip-group">${STATUSES.map((status) => statusChip(item, status)).join("")}</div>
            <button class="mini-btn danger" data-delete="${item.id}">删除</button>
          </div>
        </div>
        <div class="senses">${escapeHtml(item.senses || "（暂无释义）").replace(/\n/g, "<br>")}</div>
        ${contexts}
        <div class="vocab-meta">收录于 ${fmtDate(item.first_seen_at)} · ${item.source === "llm" ? "AI 释义" : item.source === "free" ? "免费翻译" : "本地词典"}</div>
      </article>`;
  }

  function bindCards() {
    listEl.querySelectorAll("[data-speak]").forEach((button) => {
      button.addEventListener("click", () => speak(button.dataset.speak));
    });
    listEl.querySelectorAll("[data-status-set]").forEach((button) => {
      button.addEventListener("click", async () => {
        const id = Number(button.dataset.id);
        const status = button.dataset.statusSet;
        try {
          await api(`/api/vocab/${id}`, { method: "PATCH", body: { status } });
          const item = state.items.find((entry) => entry.id === id);
          if (item) item.status = status;
          toast(`已标记为${statusLabel(status)}`);
          renderList();
        } catch (error) {
          toast(error.message, "warn");
        }
      });
    });
    listEl.querySelectorAll("[data-delete]").forEach((button) => {
      button.addEventListener("click", async () => {
        if (!confirm("从生词本删除这个词？")) return;
        try {
          await api(`/api/vocab/${button.dataset.delete}`, { method: "DELETE" });
          state.items = state.items.filter((item) => item.id !== Number(button.dataset.delete));
          state.total = Math.max(0, state.total - 1);
          toast("已删除");
          renderList();
        } catch (error) {
          toast(error.message, "warn");
        }
      });
    });
  }

  function renderList() {
    totalEl.textContent = state.total;
    if (!state.items.length) {
      const filtered = state.status !== "all" || state.q;
      listEl.innerHTML = `
        <div class="empty-state">
          <h2>${filtered ? "没有符合条件的词" : "生词本还是空的"}</h2>
          <p>${filtered ? "换个筛选条件或搜索词试试。" : "打开一篇 PDF，双击不认识的单词就能收进来。"}</p>
          ${filtered ? "" : '<a class="btn primary" href="#/">去读论文</a>'}
        </div>`;
      loadMore.hidden = true;
      return;
    }
    listEl.innerHTML = state.items.map(card).join("");
    bindCards();
    loadMore.hidden = state.items.length >= state.total;
  }

  async function load(reset = true) {
    if (state.loading) return;
    state.loading = true;
    if (reset) {
      state.offset = 0;
      state.items = [];
    }
    loadMore.disabled = true;
    loadMore.textContent = "加载中…";
    try {
      const params = new URLSearchParams({
        status: state.status,
        q: state.q,
        limit: String(limit),
        offset: String(state.offset),
      });
      const data = await api(`/api/vocab?${params}`);
      state.total = data.total;
      state.items = reset ? data.items : state.items.concat(data.items);
      renderList();
    } catch (error) {
      listEl.innerHTML = `<div class="empty-state"><p>${escapeHtml(error.message)}</p></div>`;
    } finally {
      state.loading = false;
      loadMore.disabled = false;
      loadMore.textContent = "加载更多";
    }
  }

  filter.addEventListener("click", (event) => {
    const button = event.target.closest("[data-status]");
    if (!button) return;
    state.status = button.dataset.status;
    filter.querySelectorAll("[data-status]").forEach((entry) => {
      entry.classList.toggle("active", entry === button);
    });
    load(true);
  });

  search.addEventListener(
    "input",
    debounce(() => {
      state.q = search.value.trim();
      load(true);
    }, 250)
  );

  loadMore.addEventListener("click", () => {
    state.offset = state.items.length;
    load(false);
  });

  load(true);
}
