import { api, uploadPdf } from "./api.js";
import { escapeHtml, fmtDate, toast } from "./ui.js";

export async function mountLibrary(view) {
  view.innerHTML = `
    <div class="page-wrap">
      <section class="hero">
        <div>
          <h1>把论文读成自己的词库</h1>
          <p>拖入 PDF，双击取词，释义、原句和生词量都会自动记下来。</p>
        </div>
        <div class="hero-note">本地运行 · 词典离线 · 数据只在这台电脑</div>
      </section>
      <div id="dict-warning"></div>
      <div class="dropzone" id="dropzone" role="button" tabindex="0">
        <input type="file" id="file-input" accept="application/pdf,.pdf" hidden>
        <div class="drop-icon">PDF</div>
        <div class="drop-title">拖入 PDF，或点击选择文件</div>
        <div class="drop-sub">支持文本型 PDF，单文件最大 200 MB</div>
      </div>
      <div class="upload-box" id="upload-box" hidden>
        <div class="upload-line">
          <span id="upload-name"></span>
          <span id="upload-pct">0%</span>
        </div>
        <div class="bar"><span id="upload-bar"></span></div>
      </div>
      <section class="section">
        <div class="section-head">
          <h2>我的文档</h2>
          <span class="muted" id="doc-count"></span>
        </div>
        <div id="doc-list"></div>
      </section>
    </div>`;

  const dropzone = view.querySelector("#dropzone");
  const input = view.querySelector("#file-input");
  const uploadBox = view.querySelector("#upload-box");
  const uploadName = view.querySelector("#upload-name");
  const uploadPct = view.querySelector("#upload-pct");
  const uploadBar = view.querySelector("#upload-bar");
  const docList = view.querySelector("#doc-list");
  const docCount = view.querySelector("#doc-count");
  let uploading = false;

  function renderDocs(items) {
    docCount.textContent = items.length ? `${items.length} 篇` : "";
    if (!items.length) {
      docList.innerHTML = `
        <div class="empty-state small">
          <p>还没有文档。上传一篇 PDF 就能开始取词。</p>
        </div>`;
      return;
    }
    docList.innerHTML = items
      .map((doc) => {
        const pages = doc.pages || 0;
        const last = Math.min(doc.last_page || 1, pages || 1);
        const percent = pages ? Math.min(100, Math.round((last / pages) * 100)) : 0;
        return `
          <article class="doc-card">
            <div class="doc-icon">PDF</div>
            <div class="doc-main">
              <div class="doc-title" title="${escapeHtml(doc.title)}">${escapeHtml(doc.title)}</div>
              <div class="doc-meta">
                <span>${pages} 页</span>
                <span>进度 ${last}/${pages || "?"}</span>
                <span>${doc.words || 0} 个生词</span>
                <span>${fmtDate(doc.added_at)}</span>
              </div>
              <div class="bar thin"><span style="width:${percent}%"></span></div>
            </div>
            <div class="doc-actions">
              <a class="btn primary" href="#/read/${doc.id}">${percent > 0 ? "继续阅读" : "开始阅读"}</a>
              <button class="btn ghost danger" data-delete="${doc.id}">删除</button>
            </div>
          </article>`;
      })
      .join("");
    docList.querySelectorAll("[data-delete]").forEach((button) => {
      button.addEventListener("click", async () => {
        const id = Number(button.dataset.delete);
        if (!confirm("删除这篇文档？已收录的生词会保留，但会失去这篇文档的语境。")) return;
        try {
          await api(`/api/documents/${id}`, { method: "DELETE" });
          toast("文档已删除");
          loadDocs();
        } catch (error) {
          toast(error.message, "warn");
        }
      });
    });
  }

  async function loadDocs() {
    try {
      const data = await api("/api/documents");
      renderDocs(data.items || []);
    } catch (error) {
      docList.innerHTML = `<div class="empty-state small"><p>${escapeHtml(error.message)}</p></div>`;
    }
  }

  async function checkDict() {
    try {
      const health = await api("/api/health");
      if (!health.dict_count) {
        view.querySelector("#dict-warning").innerHTML = `
          <div class="notice warn">
            词典还没有导入。先在项目目录运行 <code>python importer.py</code>，然后刷新页面。
          </div>`;
      }
    } catch (error) {
      view.querySelector("#dict-warning").innerHTML = `
        <div class="notice warn">${escapeHtml(error.message)}</div>`;
    }
  }

  async function handleFiles(files) {
    if (uploading) return;
    const file = files && files[0];
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      toast("只支持 PDF 文件", "warn");
      return;
    }
    uploading = true;
    uploadBox.hidden = false;
    uploadName.textContent = file.name;
    uploadPct.textContent = "0%";
    uploadBar.style.width = "0%";
    dropzone.classList.add("busy");
    try {
      const doc = await uploadPdf(file, (ratio) => {
        const percent = Math.min(100, Math.round(ratio * 100));
        uploadPct.textContent = `${percent}%`;
        uploadBar.style.width = `${percent}%`;
      });
      toast("上传完成，正在打开");
      location.hash = `#/read/${doc.id}`;
    } catch (error) {
      toast(error.message, "warn");
      uploadBox.hidden = true;
    } finally {
      uploading = false;
      dropzone.classList.remove("busy");
      input.value = "";
    }
  }

  dropzone.addEventListener("click", () => {
    if (!uploading) input.click();
  });
  dropzone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      input.click();
    }
  });
  input.addEventListener("change", () => handleFiles(input.files));
  dropzone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropzone.classList.add("drag");
  });
  dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag"));
  dropzone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropzone.classList.remove("drag");
    handleFiles(event.dataTransfer.files);
  });

  checkDict();
  loadDocs();
}
