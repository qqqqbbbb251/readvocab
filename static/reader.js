import * as pdfjsLib from "./vendor/pdfjs/pdf.mjs";
import { api } from "./api.js";
import { debounce, escapeHtml, toast } from "./ui.js";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/static/vendor/pdfjs/pdf.worker.mjs";

const popupRoot = document.getElementById("popup-root");

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function cleanSelection(raw) {
  let value = raw.normalize("NFKC").replace(/\u00ad/g, "");
  value = value.replace(/-\s*\n\s*/g, "");
  value = value.replace(/\s+/g, " ").trim();
  return value.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

function buildPageText(items) {
  const parts = [];
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    parts.push(item.str);
    if (item.hasEOL) parts.push("\n");
  }
  return parts
    .join(" ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function extractSentence(pageText, target) {
  if (!pageText) return "";
  const flat = pageText.replace(/\s+/g, " ").trim();
  const needle = target.toLowerCase().replace(/\s+/g, " ").trim();
  if (!needle) return "";
  let index = flat.toLowerCase().indexOf(needle);
  if (index === -1) {
    index = flat.toLowerCase().indexOf(needle.split(" ")[0]);
  }
  if (index === -1) return "";
  const before = flat.slice(0, index);
  let start = 0;
  const boundaries = [...before.matchAll(/[.!?:;](?=\s|$)/g)];
  if (boundaries.length) {
    start = boundaries[boundaries.length - 1].index + 1;
  } else {
    const lineStart = before.lastIndexOf("\n");
    if (lineStart >= 0) start = lineStart + 1;
  }
  const after = flat.slice(index);
  const endMatch = after.match(/[.!?](?=\s|$)/);
  const end = endMatch ? index + endMatch.index + 1 : flat.length;
  let sentence = flat.slice(start, end).replace(/\s+/g, " ").trim();
  if (sentence.length > 500) {
    sentence = sentence.slice(0, 500).trim();
  }
  return sentence;
}

function sensesHtml(text) {
  const lines = String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return "";
  return `<div class="popup-senses">${lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}</div>`;
}

function loadingHtml(text) {
  return `<div class="popup-loading"><span class="spinner"></span>${escapeHtml(text)}</div>`;
}

function errorHtml(message) {
  return `<div class="popup-error">${escapeHtml(message)}</div>`;
}

export async function mountReader(view, docId) {
  const [data, health] = await Promise.all([
    api("/api/documents"),
    api("/api/health").catch(() => ({})),
  ]);
  const doc = (data.items || []).find((item) => item.id === docId);
  if (!doc) throw new Error("文档不存在或已被删除");
  const llmAvailable = !!health.llm_configured;

  view.innerHTML = `
    <div class="reader">
      <div class="reader-bar">
        <a class="btn ghost small" href="#/">返回文库</a>
        <div class="reader-title" title="${escapeHtml(doc.title)}">${escapeHtml(doc.title)}</div>
        <div class="reader-tools">
          <button class="icon-btn" data-zoom="out" title="缩小">−</button>
          <span class="zoom-label" id="zoom-label">100%</span>
          <button class="icon-btn" data-zoom="in" title="放大">+</button>
          <span class="page-indicator" id="page-indicator">1 / ${doc.pages || "?"}</span>
        </div>
      </div>
      <div class="reader-scroll" id="reader-scroll">
        <div class="pages" id="pages"></div>
      </div>
      <div class="reader-loading" id="reader-loading">
        <span class="spinner big"></span>
        <span>正在加载 PDF…</span>
      </div>
    </div>`;

  const scrollEl = view.querySelector("#reader-scroll");
  const pagesEl = view.querySelector("#pages");
  const loadingEl = view.querySelector("#reader-loading");
  const pageIndicator = view.querySelector("#page-indicator");
  const zoomLabel = view.querySelector("#zoom-label");

  const loadingTask = pdfjsLib.getDocument({
    url: `/api/documents/${docId}/file`,
    standardFontDataUrl: "/static/vendor/pdfjs/standard_fonts/",
  });

  let pdf;
  try {
    pdf = await loadingTask.promise;
  } catch (error) {
    loadingEl.innerHTML = `<div class="popup-error">PDF 加载失败：${escapeHtml(error.message || error)}</div>`;
    throw error;
  }

  const firstPage = await pdf.getPage(1);
  const baseSize = firstPage.getViewport({ scale: 1 });
  let zoom = 1;
  let scale = 1;
  let generation = 0;
  let currentPage = clamp(doc.last_page || 1, 1, pdf.numPages);
  let popup = null;
  let popupRect = null;
  let popupToken = 0;
  let selecting = false;
  let observer = null;
  let chain = Promise.resolve();
  let firstShown = false;
  let textWarned = false;
  const pageEls = [];
  const pageTexts = new Map();
  const rendered = new Set();
  const pending = new Set();

  function calcScale() {
    const available = Math.max(320, scrollEl.clientWidth - 56);
    const fit = available / baseSize.width;
    return clamp(fit * zoom, 0.4, 4);
  }

  scale = calcScale();

  function rebuildPages() {
    pagesEl.innerHTML = "";
    pageEls.length = 0;
    for (let number = 1; number <= pdf.numPages; number += 1) {
      const el = document.createElement("div");
      el.className = "pdf-page";
      el.dataset.page = String(number);
      el.style.width = `${baseSize.width * scale}px`;
      el.style.height = `${baseSize.height * scale}px`;
      el.style.setProperty("--scale-factor", scale);
      el.innerHTML = `<div class="page-surface"></div><span class="page-label">${number}</span>`;
      pagesEl.appendChild(el);
      pageEls.push(el);
    }
  }

  function startObserver() {
    if (observer) observer.disconnect();
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            schedule(Number(entry.target.dataset.page));
          }
        }
      },
      { root: scrollEl, rootMargin: "800px 0px", threshold: 0 }
    );
    pageEls.forEach((el) => observer.observe(el));
  }

  function schedule(number) {
    if (number < 1 || number > pdf.numPages) return;
    if (rendered.has(number) || pending.has(number)) return;
    const gen = generation;
    pending.add(number);
    chain = chain
      .then(() => {
        if (gen !== generation) return null;
        return renderPage(number, gen);
      })
      .catch((error) => console.error("render page failed", error))
      .finally(() => pending.delete(number));
  }

  async function renderPage(number, gen) {
    const page = await pdf.getPage(number);
    if (gen !== generation) return;
    const viewport = page.getViewport({ scale });
    const el = pageEls[number - 1];
    if (!el) return;
    el.style.width = `${viewport.width}px`;
    el.style.height = `${viewport.height}px`;
    el.style.setProperty("--scale-factor", scale);
    const surface = el.querySelector(".page-surface");
    if (!surface) return;
    const canvas = document.createElement("canvas");
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.floor(viewport.width * ratio);
    canvas.height = Math.floor(viewport.height * ratio);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    const textLayerEl = document.createElement("div");
    textLayerEl.className = "textLayer";
    surface.replaceChildren(canvas, textLayerEl);
    const context = canvas.getContext("2d", { alpha: false });
    await page.render({
      canvasContext: context,
      viewport,
      background: "#ffffff",
      transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null,
    }).promise;
    if (gen !== generation) return;
    const textContent = await page.getTextContent();
    if (gen !== generation) return;
    if (!textContent.items.length && !textWarned) {
      textWarned = true;
      toast("这个 PDF 没有文本层，可能无法取词", "warn");
    }
    pageTexts.set(number, buildPageText(textContent.items));
    const layer = new pdfjsLib.TextLayer({
      textContentSource: textContent,
      container: textLayerEl,
      viewport,
    });
    await layer.render();
    if (gen !== generation) return;
    rendered.add(number);
    if (!firstShown) {
      firstShown = true;
      loadingEl.hidden = true;
    }
  }

  function scrollToPage(number) {
    const el = pageEls[clamp(number, 1, pageEls.length) - 1];
    if (!el) return;
    scrollEl.scrollTop = Math.max(0, el.offsetTop - 8);
  }

  function applyScale() {
    generation += 1;
    rendered.clear();
    pending.clear();
    chain = Promise.resolve();
    scale = calcScale();
    for (const el of pageEls) {
      el.style.width = `${baseSize.width * scale}px`;
      el.style.height = `${baseSize.height * scale}px`;
      el.style.setProperty("--scale-factor", scale);
      const surface = el.querySelector(".page-surface");
      if (surface) surface.replaceChildren();
    }
    scrollToPage(currentPage);
    schedule(currentPage - 1);
    schedule(currentPage);
    schedule(currentPage + 1);
  }

  function updateCurrentPage() {
    const marker = scrollEl.getBoundingClientRect().top + Math.min(140, scrollEl.clientHeight * 0.3);
    let page = currentPage;
    for (const el of pageEls) {
      const rect = el.getBoundingClientRect();
      if (rect.bottom >= marker) {
        page = Number(el.dataset.page);
        break;
      }
    }
    if (page !== currentPage) {
      currentPage = page;
      pageIndicator.textContent = `${page} / ${pdf.numPages}`;
      saveProgress();
    }
  }

  function saveProgressNow() {
    api(`/api/documents/${docId}`, { method: "PATCH", body: { last_page: currentPage } }).catch(
      () => {}
    );
  }

  const saveProgress = debounce(saveProgressNow, 1200);

  function closePopup() {
    popupToken += 1;
    if (popup) {
      popup.remove();
      popup = null;
      popupRect = null;
    }
  }

  function positionPopup() {
    if (!popup || !popupRect) return;
    popup.style.left = "0px";
    popup.style.top = "0px";
    const margin = 10;
    const width = popup.offsetWidth;
    const height = popup.offsetHeight;
    let left = popupRect.left + popupRect.width / 2 - width / 2;
    left = clamp(left, margin, window.innerWidth - width - margin);
    let top = popupRect.bottom + 8;
    if (top + height > window.innerHeight - margin) {
      const above = popupRect.top - height - 8;
      top = above >= margin ? above : Math.max(margin, window.innerHeight - height - margin);
    }
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
  }

  function openPopup(rect, html) {
    if (popup) popup.remove();
    popup = document.createElement("div");
    popup.className = "lookup-popup";
    popup.innerHTML = html;
    popupRoot.appendChild(popup);
    popupRect = rect;
    positionPopup();
    return popup;
  }

  function bindAdd(box, prepared) {
    const button = box.querySelector("[data-add]");
    if (!button) return;
    api(`/api/vocab/check?lemma=${encodeURIComponent(prepared.lemma)}`)
      .then((result) => {
        if (result.found && button.isConnected) {
          button.textContent = "已在生词本 · 补充语境";
        }
      })
      .catch(() => {});
    button.addEventListener("click", async () => {
      if (button.disabled) return;
      button.disabled = true;
      const original = button.textContent;
      button.textContent = "保存中…";
      try {
        const result = await api("/api/vocab", { method: "POST", body: prepared });
        button.textContent = result.created ? "已加入生词本" : "语境已补充";
        button.classList.remove("primary");
        toast(result.created ? `已收录 ${prepared.lemma}` : `${prepared.lemma} 已在生词本`);
        window.dispatchEvent(new CustomEvent("vocab-changed", { detail: result }));
      } catch (error) {
        button.disabled = false;
        button.textContent = original;
        toast(error.message, "warn");
      }
    });
  }

  function bindSpeak(box, word) {
    const button = box.querySelector("[data-speak]");
    if (!button) return;
    button.addEventListener("click", () => {
      if (!("speechSynthesis" in window)) {
        toast("当前浏览器不支持语音朗读", "warn");
        return;
      }
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(word);
      utterance.lang = "en-US";
      utterance.rate = 0.9;
      window.speechSynthesis.speak(utterance);
    });
  }

  async function runFreeTranslate(box, text, context) {
    const token = popupToken;
    box.innerHTML = loadingHtml("免费翻译中…");
    positionPopup();
    try {
      const response = await api("/api/free-translate", {
        method: "POST",
        body: { text },
      });
      if (token !== popupToken) return;
      const translation = response.translation || "";
      const prepared = {
        lemma: text.toLowerCase(),
        form: text,
        phonetic: "",
        senses: translation,
        definition: "",
        source: "free",
        doc_id: docId,
        page: context.page,
        sentence: context.sentence,
      };
      box.innerHTML = `
        <div class="popup-head">
          <div class="popup-wordline"><strong>${escapeHtml(context.isWord ? text : "免费翻译")}</strong></div>
          <div class="popup-sub">MyMemory${response.cached ? " · 缓存命中" : ""}</div>
        </div>
        <div class="popup-translation">${escapeHtml(translation).replace(/\n/g, "<br>")}</div>
        ${context.sentence && context.sentence !== text ? `<blockquote class="popup-context">${escapeHtml(context.sentence)}</blockquote>` : ""}
        <div class="popup-actions">
          ${context.isWord ? `<button class="btn primary small" data-add>加入生词本</button>` : ""}
          <button class="btn small" data-copy>复制译文</button>
          ${llmAvailable ? `<button class="btn small" data-ai>AI 翻译（更准）</button>` : ""}
        </div>
        <p class="popup-footnote">免费翻译适合快速理解，术语和长句可能不够准确。</p>`;
      if (context.isWord) bindAdd(box, prepared);
      box.querySelector("[data-copy]").addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(translation);
          toast("译文已复制");
        } catch (error) {
          toast("复制失败，请手动选择文本", "warn");
        }
      });
      const aiButton = box.querySelector("[data-ai]");
      if (aiButton) {
        aiButton.addEventListener("click", () => {
          if (context.isWord) {
            runAiWord(box, text, context);
          } else {
            runAiSentence(box, text, context);
          }
        });
      }
      positionPopup();
    } catch (error) {
      if (token !== popupToken) return;
      box.innerHTML = errorHtml(error.message);
      positionPopup();
    }
  }

  function renderDict(box, result, context) {
    const prepared = {
      lemma: (result.lemma || context.text).toLowerCase(),
      form: result.form || context.text,
      phonetic: result.phonetic || "",
      senses: result.translation || "",
      definition: result.definition || "",
      source: "dict",
      doc_id: docId,
      page: context.page,
      sentence: context.sentence,
    };
    const sub = [
      result.phonetic ? `<span class="phonetic">/${escapeHtml(result.phonetic)}/</span>` : "",
      result.note ? `<span class="note">${escapeHtml(result.note)}</span>` : "",
    ]
      .filter(Boolean)
      .join("");
    box.innerHTML = `
      <div class="popup-head">
        <div class="popup-wordline">
          <strong>${escapeHtml(result.form || context.text)}</strong>
          <button class="mini-btn" data-speak>发音</button>
        </div>
        ${sub ? `<div class="popup-sub">${sub}</div>` : ""}
      </div>
      ${
        result.found
          ? sensesHtml(result.translation)
          : `<p class="popup-muted">本地词典没有收录${context.isWord ? "这个词" : "这个短语"}。</p>`
      }
      ${
        result.found && result.definition
          ? `<details class="popup-def"><summary>英文释义</summary><p>${escapeHtml(result.definition).replace(/\n/g, "<br>")}</p></details>`
          : ""
      }
      ${context.sentence ? `<blockquote class="popup-context">${escapeHtml(context.sentence)}</blockquote>` : ""}
      <div class="popup-actions">
        <button class="btn primary small" data-add>加入生词本</button>
        ${result.found ? "" : `<button class="btn small" data-free>免费翻译</button>`}
        ${context.sentence ? `<button class="btn small" data-sentence>免费翻译本句</button>` : ""}
        ${!result.found && llmAvailable ? `<button class="btn small" data-ai>AI 查词</button>` : ""}
      </div>`;
    bindSpeak(box, result.form || context.text);
    bindAdd(box, prepared);
    const freeButton = box.querySelector("[data-free]");
    if (freeButton) {
      freeButton.addEventListener("click", () => runFreeTranslate(box, context.text, context));
    }
    const sentenceButton = box.querySelector("[data-sentence]");
    if (sentenceButton) {
      sentenceButton.addEventListener("click", () => {
        runFreeTranslate(box, context.sentence, {
          ...context,
          text: context.sentence,
          isWord: false,
        });
      });
    }
    const aiButton = box.querySelector("[data-ai]");
    if (aiButton) {
      aiButton.addEventListener("click", () => runAiWord(box, context.text, context));
    }
    positionPopup();
  }

  function renderSentencePrompt(box, text, context) {
    const count = text.split(/\s+/).filter(Boolean).length;
    box.innerHTML = `
      <div class="popup-sub">选中 ${count} 个词</div>
      <p class="popup-quote">${escapeHtml(text.slice(0, 320))}${text.length > 320 ? "…" : ""}</p>
      <div class="popup-actions">
        <button class="btn primary small" data-free>免费翻译</button>
        ${llmAvailable ? `<button class="btn small" data-ai>AI 翻译（更准）</button>` : ""}
      </div>
      <p class="popup-footnote">免费翻译由 MyMemory 提供，适合快速理解。</p>`;
    box.querySelector("[data-free]").addEventListener("click", () => {
      runFreeTranslate(box, text, context);
    });
    const aiButton = box.querySelector("[data-ai]");
    if (aiButton) {
      aiButton.addEventListener("click", () => {
        runAiSentence(box, text, context);
      });
    }
    positionPopup();
  }

  async function runAiWord(box, text, context) {
    const token = popupToken;
    box.innerHTML = loadingHtml("AI 正在解释…");
    positionPopup();
    try {
      const response = await api("/api/translate", {
        method: "POST",
        body: { text, mode: "word", context: context.sentence },
      });
      if (token !== popupToken) return;
      const ai = response.result;
      const senses = (ai.senses || [])
        .map((sense) => `${sense.pos ? `${sense.pos} ` : ""}${sense.cn}`)
        .join("\n");
      const prepared = {
        lemma: text.toLowerCase(),
        form: text,
        phonetic: ai.phonetic || "",
        senses: senses || ai.definition || "",
        definition: ai.definition || "",
        source: "llm",
        doc_id: docId,
        page: context.page,
        sentence: context.sentence,
      };
      box.innerHTML = `
        <div class="popup-head">
          <div class="popup-wordline">
            <strong>${escapeHtml(text)}</strong>
            <button class="mini-btn" data-speak>发音</button>
            <span class="tag">AI</span>
          </div>
          <div class="popup-sub">${ai.phonetic ? `<span class="phonetic">/${escapeHtml(ai.phonetic)}/</span>` : ""}</div>
        </div>
        ${sensesHtml(senses)}
        ${ai.definition ? `<details class="popup-def" open><summary>英文释义</summary><p>${escapeHtml(ai.definition)}</p></details>` : ""}
        ${ai.example ? `<p class="popup-example">${escapeHtml(ai.example)}</p>` : ""}
        ${context.sentence ? `<blockquote class="popup-context">${escapeHtml(context.sentence)}</blockquote>` : ""}
        <div class="popup-actions">
          <button class="btn primary small" data-add>加入生词本</button>
        </div>`;
      bindSpeak(box, text);
      bindAdd(box, prepared);
      positionPopup();
    } catch (error) {
      if (token !== popupToken) return;
      box.innerHTML = errorHtml(error.message);
      positionPopup();
    }
  }

  async function runAiSentence(box, text, context) {
    const token = popupToken;
    box.innerHTML = loadingHtml("AI 正在翻译…");
    positionPopup();
    try {
      const response = await api("/api/translate", {
        method: "POST",
        body: { text, mode: "sentence", context: context.sentence },
      });
      if (token !== popupToken) return;
      const translation = (response.result && response.result.translation) || "";
      box.innerHTML = `
        <div class="popup-sub">AI 译文${response.cached ? " · 缓存命中" : ""}</div>
        <div class="popup-translation">${escapeHtml(translation).replace(/\n/g, "<br>")}</div>
        <div class="popup-actions">
          <button class="btn small" data-copy>复制译文</button>
        </div>`;
      box.querySelector("[data-copy]").addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(translation);
          toast("译文已复制");
        } catch (error) {
          toast("复制失败，请手动选择文本", "warn");
        }
      });
      positionPopup();
    } catch (error) {
      if (token !== popupToken) return;
      box.innerHTML = errorHtml(error.message);
      positionPopup();
    }
  }

  async function showLookup(text, pageEl, rect) {
    const token = popupToken + 1;
    popupToken = token;
    const page = Number(pageEl.dataset.page);
    const sentence = extractSentence(pageTexts.get(page) || "", text);
    const words = text.split(/\s+/).filter(Boolean);
    const isWord = words.length === 1;
    const context = { text, sentence, page, isWord };
    const box = openPopup(rect, loadingHtml(isWord ? "查词中…" : "查询中…"));
    if (words.length > 6) {
      renderSentencePrompt(box, text, context);
      return;
    }
    try {
      const result = await api("/api/lookup", { method: "POST", body: { text } });
      if (token !== popupToken || !popup) return;
      if (!result.found && !isWord) {
        renderSentencePrompt(box, text, context);
        return;
      }
      renderDict(box, result, context);
    } catch (error) {
      if (token !== popupToken || !popup) return;
      box.innerHTML = errorHtml(error.message);
      positionPopup();
    }
  }

  function onMouseUp() {
    if (!selecting) return;
    selecting = false;
    setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;
      const raw = selection.toString();
      if (!raw.trim()) return;
      const range = selection.getRangeAt(0);
      const node =
        range.startContainer.nodeType === 1
          ? range.startContainer
          : range.startContainer.parentElement;
      if (!node || !node.closest) return;
      const pageEl = node.closest(".pdf-page");
      if (!pageEl || !scrollEl.contains(pageEl)) return;
      const text = cleanSelection(raw);
      if (!text) return;
      const rect = range.getBoundingClientRect();
      if (!rect.width && !rect.height) return;
      showLookup(text, pageEl, rect);
    }, 0);
  }

  function onMouseDown() {
    selecting = true;
    if (popup) closePopup();
  }

  function onDocMouseDown(event) {
    if (popup && !popup.contains(event.target)) closePopup();
    if (!scrollEl.contains(event.target)) selecting = false;
  }

  function onKeyDown(event) {
    if (event.key === "Escape") closePopup();
  }

  let scrollFrame = 0;
  function onScroll() {
    if (popup) closePopup();
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      updateCurrentPage();
    });
  }

  const onResize = debounce(() => {
    if (!pdf) return;
    applyScale();
  }, 300);

  view.querySelectorAll("[data-zoom]").forEach((button) => {
    button.addEventListener("click", () => {
      const factor = button.dataset.zoom === "in" ? 1.15 : 1 / 1.15;
      zoom = clamp(zoom * factor, 0.5, 2.5);
      zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
      applyScale();
    });
  });

  rebuildPages();
  startObserver();
  scrollToPage(currentPage);
  updateCurrentPage();
  pageIndicator.textContent = `${currentPage} / ${pdf.numPages}`;
  schedule(currentPage);
  schedule(currentPage + 1);
  scrollEl.addEventListener("scroll", onScroll, { passive: true });
  scrollEl.addEventListener("mousedown", onMouseDown);
  document.addEventListener("mouseup", onMouseUp);
  document.addEventListener("mousedown", onDocMouseDown);
  document.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", onResize);

  return () => {
    if (observer) observer.disconnect();
    scrollEl.removeEventListener("scroll", onScroll);
    scrollEl.removeEventListener("mousedown", onMouseDown);
    document.removeEventListener("mouseup", onMouseUp);
    document.removeEventListener("mousedown", onDocMouseDown);
    document.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("resize", onResize);
    closePopup();
    if ("speechSynthesis" in window) window.speechSynthesis.cancel();
    saveProgressNow();
    try {
      loadingTask.destroy();
    } catch (error) {}
    try {
      pdf.destroy();
    } catch (error) {}
  };
}
