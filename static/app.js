import { api } from "./api.js";
import { errorView } from "./ui.js";
import { mountLibrary } from "./library.js";
import { mountVocab } from "./vocab.js";
import { mountStats } from "./stats.js";
import { mountReader } from "./reader.js";

const view = document.getElementById("view");
const badge = document.getElementById("today-badge");
const themeBtn = document.getElementById("theme-btn");
let cleanup = null;

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("readvocab-theme", theme);
  themeBtn.title = theme === "dark" ? "切换到浅色" : "切换到深色";
}

function initTheme() {
  const saved = localStorage.getItem("readvocab-theme");
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(saved || (prefersDark ? "dark" : "light"));
  themeBtn.addEventListener("click", () => {
    applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
  });
}

function setNav(name) {
  document.querySelectorAll("[data-nav]").forEach((link) => {
    link.classList.toggle("active", link.dataset.nav === name);
  });
}

async function updateBadge(todayValue) {
  try {
    let today = todayValue;
    if (today === undefined) {
      const stats = await api("/api/stats");
      today = stats.today_new;
    }
    badge.hidden = false;
    badge.textContent = today > 0 ? `今日 +${today}` : "今日 0";
  } catch (error) {
    badge.hidden = true;
  }
}

function parseRoute() {
  const hash = location.hash.replace(/^#/, "") || "/";
  const parts = hash.split("/").filter(Boolean);
  if (parts[0] === "read" && parts[1]) {
    return { name: "reader", id: Number(parts[1]) };
  }
  if (parts[0] === "vocab") return { name: "vocab" };
  if (parts[0] === "stats") return { name: "stats" };
  return { name: "library" };
}

async function render() {
  if (typeof cleanup === "function") {
    try {
      cleanup();
    } catch (error) {
      console.error(error);
    }
    cleanup = null;
  }
  const route = parseRoute();
  document.body.classList.toggle("reader-mode", route.name === "reader");
  setNav(route.name === "reader" ? "library" : route.name);
  view.innerHTML = "";
  updateBadge();
  try {
    if (route.name === "library") {
      cleanup = await mountLibrary(view);
    } else if (route.name === "vocab") {
      cleanup = await mountVocab(view);
    } else if (route.name === "stats") {
      cleanup = await mountStats(view);
    } else if (route.name === "reader") {
      cleanup = await mountReader(view, route.id);
    }
  } catch (error) {
    console.error(error);
    errorView(view, error);
  }
}

window.addEventListener("vocab-changed", (event) => {
  if (event.detail && typeof event.detail.today === "number") {
    updateBadge(event.detail.today);
  } else {
    updateBadge();
  }
});

window.addEventListener("hashchange", render);
initTheme();
render();
