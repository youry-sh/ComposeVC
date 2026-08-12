const assert = require("assert");
const { rankCustomTools, selectCustomToolsForInject } = require("../electron/customTools.cjs");

function tool(name, description, tags = [], properties = {}) {
  return { id: name, name, title: name.replaceAll("_", " "), description, tags, enabled: true,
    inputSchema: { type: "object", properties } };
}

const noise = Array.from({ length: 997 }, (_, i) =>
  tool(`generic_utility_${i}`, `Generic utility number ${i} for routine data processing`, ["utility"])
);
const catalog = [
  ...noise,
  tool("telegram_video_downloader", "Download and save videos from Telegram channels", ["telegram", "video", "download"]),
  tool("gmail_message_search", "Search email messages and attachments in Gmail", ["email", "search"]),
  tool("image_format_converter", "Convert pictures between PNG, JPEG and WebP", ["image", "convert"]),
];

assert.equal(rankCustomTools(catalog, "скачать видео из телеграма", { limit: 10 })[0].tool.name, "telegram_video_downloader");
assert.equal(rankCustomTools(catalog, "найди письмо в почте", { limit: 10 })[0].tool.name, "gmail_message_search");
assert.equal(rankCustomTools(catalog, "convert pictuer to png", { limit: 10 })[0].tool.name, "image_format_converter");
assert.equal(rankCustomTools(catalog, "telegram video downloader", { limit: 10 })[0].tool.name, "telegram_video_downloader");

const injected = selectCustomToolsForInject(catalog, "нужно скачать ролик из tg");
assert.equal(injected.selected.length, 45);
assert(injected.selected.slice(0, 5).some((item) => item.name === "telegram_video_downloader"));
assert.equal(new Set(injected.selected.map((item) => item.name)).size, injected.selected.length);

console.log("custom-tools-search: ok (1000 tools, bilingual + fuzzy + top-K)");
