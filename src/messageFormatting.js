const ALLOWED_BLOCK_TAGS = new Set(["p", "div", "h2", "h3", "blockquote"]);
const ALLOWED_INLINE_TAGS = new Set(["strong", "b", "em", "i", "u", "br"]);

function safeHref(value) {
  const href = String(value || "").trim();
  if (/^(https?:|mailto:)/i.test(href)) return href;
  return "";
}

/**
 * Keep the small HTML vocabulary produced by the message editor. This is
 * intentionally strict because message HTML is displayed in the dashboard
 * and sent to email recipients.
 */
export function sanitizeRichTextHtml(value) {
  let html = String(value || "")
    .replace(/<!--([\s\S]*?)-->/g, "")
    .replace(/<\s*(script|style|iframe|object|embed|form|svg|math)[^>]*>[\s\S]*?<\/\s*\1\s*>/gi, "");

  html = html.replace(/<\/?([a-z][\w-]*)([^>]*)>/gi, (match, rawTag, rawAttributes = "") => {
    const tag = String(rawTag).toLowerCase();
    const isClosing = /^<\//.test(match);
    if (isClosing) {
      if (tag === "a" || tag === "ul" || tag === "ol" || tag === "li" || ALLOWED_BLOCK_TAGS.has(tag) || ALLOWED_INLINE_TAGS.has(tag)) {
        return `</${tag}>`;
      }
      return "";
    }

    if (tag === "ul" || tag === "ol" || tag === "li" || ALLOWED_BLOCK_TAGS.has(tag) || ALLOWED_INLINE_TAGS.has(tag)) {
      return `<${tag}>`;
    }
    if (tag === "a") {
      const hrefMatch = String(rawAttributes).match(/\bhref\s*=\s*["']([^"']+)["']/i);
      const href = safeHref(hrefMatch?.[1]);
      return href
        ? `<a href="${escapeAttribute(href)}" target="_blank" rel="noopener noreferrer">`
        : "";
    }
    return "";
  });

  return linkifyPlainUrls(html).trim();
}

function linkifyPlainUrls(html) {
  let insideAnchor = false;
  return String(html || "").split(/(<[^>]+>)/g).map((part) => {
    if (!part) return part;
    if (/^<a\b/i.test(part)) {
      insideAnchor = true;
      return part;
    }
    if (/^<\/a>/i.test(part)) {
      insideAnchor = false;
      return part;
    }
    if (part.startsWith("<") || insideAnchor) return part;
    return part.replace(/(https?:\/\/[^\s<]+)/gi, (url) => {
      const trailingMatch = url.match(/[.,!?;:'")\]}]+$/);
      const punctuation = trailingMatch?.[0] || "";
      const cleanUrl = punctuation ? url.slice(0, -punctuation.length) : url;
      return `<a href="${escapeAttribute(cleanUrl)}" target="_blank" rel="noopener noreferrer">${cleanUrl}</a>${punctuation}`;
    });
  }).join("");
}

function escapeAttribute(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("\"", "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function escapeText(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#039;");
}

export function richTextHtmlFromPlainText(value) {
  const normalized = String(value || "").replace(/\r\n?/g, "\n");
  if (!normalized.trim()) return "";
  return normalized.split("\n").map((line) => {
    const escaped = escapeText(line);
    const linked = escaped.replace(/(https?:\/\/[^\s<]+)/gi, (url) => (
      `<a href="${escapeAttribute(url)}" target="_blank" rel="noopener noreferrer">${url}</a>`
    ));
    return `<p>${linked || "<br>"}</p>`;
  }).join("");
}
