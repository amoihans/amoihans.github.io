import { defineAstroPaperConfig } from "./src/types/config";

export default defineAstroPaperConfig({
  site: {
    url: "https://amoihans.github.io/",
    title: "Hans's Blog",
    description: "技术随笔 · 读书笔记 · 生活记录",
    author: "Hans",
    profile: "https://github.com/amoihans",
    ogImage: "default-og.jpg",
    lang: "zh",
    timezone: "Asia/Shanghai",
    dir: "ltr",
  },
  posts: {
    perPage: 5,
    perIndex: 5,
    scheduledPostMargin: 15 * 60 * 1000,
  },
  features: {
    lightAndDarkMode: true,
    dynamicOgImage: false,
    showArchives: true,
    showBackButton: true,
    editPost: {
      enabled: true,
      url: "https://github.com/amoihans/amoihans.github.io/edit/main/",
    },
    search: "pagefind",
    kanban: {
      enabled: true,
      modelPath: "/models/Hiyori/Hiyori.model3.json",
      width: 420,
      height: 600,
      scale: 1,
      idleRandomAfterMs: 8000,
      followStrength: 1,
      draggable: true,
      hiddenStorageKey: "kanban:hidden",
    },
  },
  socials: [
    { name: "github", url: "https://github.com/amoihans" },
    { name: "mail", url: "amoyhans@163.com" },
  ],
  shareLinks: [
    { name: "x", url: "https://x.com/intent/post?url=" },
    { name: "telegram", url: "https://t.me/share/url?url=" },
    { name: "mail", url: "mailto:?subject=See%20this%20post&body=" },
  ],
});
