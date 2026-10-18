const ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

export function toast(message, kind = "ok") {
  const el = document.getElementById("toast");
  if (!el) return;
  el.textContent = message;
  el.dataset.kind = kind;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 2200);
}

export function debounce(fn, wait = 200) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export function speak(text) {
  if (!("speechSynthesis" in window)) {
    toast("当前浏览器不支持语音朗读", "warn");
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-US";
  utterance.rate = 0.9;
  window.speechSynthesis.speak(utterance);
}

export function fmtDate(value) {
  return String(value || "").slice(0, 10);
}

export function statusLabel(status) {
  return { new: "新词", learning: "学习中", known: "已掌握" }[status] || status;
}

export function errorView(view, error, back = "#/") {
  view.innerHTML = `
    <div class="page-wrap narrow">
      <div class="empty-state">
        <h2>出了点问题</h2>
        <p>${escapeHtml(error.message || error)}</p>
        <a class="btn" href="${back}">返回</a>
      </div>
    </div>`;
}
