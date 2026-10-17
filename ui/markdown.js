const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function renderInlineMarkdown(s) {
  let out = esc(s);
  const inlineCodes = [];
  out = out.replace(/`([^`\n]+)`/g, (_, code) => {
    const idx = inlineCodes.push(`<code class="md-inline" dir="ltr">${code}</code>`) - 1;
    return `\u0000IC${idx}\u0000`;
  });
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, "$1<em>$2</em>");
  out = out.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  out = out.replace(/\u0000IC(\d+)\u0000/g, (_, i) => inlineCodes[Number(i)] || "");
  return out;
}

export function renderMarkdown(raw) {
  const text = String(raw ?? "").replace(/\r\n/g, "\n");
  if (!text.trim()) return "";

  const codeBlocks = [];
  const withPlaceholders = text.replace(/```([a-zA-Z0-9_+-]*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const cleanLang = (lang || "code").trim().toLowerCase();
    const trimmedCode = code.replace(/\n$/, "");
    const html = `<div class="md-code" dir="ltr">
      <div class="md-code-bar">
        <span class="md-lang">${esc(cleanLang)}</span>
        <button type="button" class="md-copy-btn" data-copy-code="${esc(trimmedCode)}">📋 نسخ الكود</button>
      </div>
      <pre><code>${esc(trimmedCode)}</code></pre>
    </div>`;
    const idx = codeBlocks.push(html) - 1;
    return `\n@@CODEBLOCK_${idx}@@\n`;
  });

  const lines = withPlaceholders.split("\n");
  const htmlParts = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i++;
      continue;
    }

    const cbMatch = trimmed.match(/^@@CODEBLOCK_(\d+)@@$/);
    if (cbMatch) {
      htmlParts.push(codeBlocks[Number(cbMatch[1])] || "");
      i++;
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      htmlParts.push("<hr class=\"md-hr\" />");
      i++;
      continue;
    }

    const hMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (hMatch) {
      const level = hMatch[1].length;
      htmlParts.push(`<h${level} class="md-h${level}" dir="auto">${renderInlineMarkdown(hMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    if (trimmed.startsWith("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const parseRow = (r) =>
        r
          .trim()
          .replace(/^\|/, "")
          .replace(/\|$/, "")
          .split("|")
          .map((c) => renderInlineMarkdown(c.trim()));
      const headers = parseRow(trimmed);
      i += 2;
      const bodyRows = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) {
        bodyRows.push(parseRow(lines[i]));
        i++;
      }
      htmlParts.push(
        `<div class="md-table-wrap"><table class="md-table" dir="auto"><thead><tr>${headers
          .map((h) => `<th>${h}</th>`)
          .join("")}</tr></thead><tbody>${bodyRows
          .map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
      continue;
    }

    if (trimmed.startsWith(">")) {
      const qLines = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        qLines.push(renderInlineMarkdown(lines[i].trim().replace(/^>\s?/, "")));
        i++;
      }
      htmlParts.push(`<blockquote class="md-quote" dir="auto">${qLines.join("<br/>")}</blockquote>`);
      continue;
    }

    if (/^[-*•]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^[-*•]\s+/.test(lines[i].trim())) {
        items.push(`<li dir="auto">${renderInlineMarkdown(lines[i].trim().replace(/^[-*•]\s+/, ""))}</li>`);
        i++;
      }
      htmlParts.push(`<ul class="md-ul">${items.join("")}</ul>`);
      continue;
    }

    if (/^\d+[.)]\s+/.test(trimmed)) {
      const items = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i].trim())) {
        items.push(`<li dir="auto">${renderInlineMarkdown(lines[i].trim().replace(/^\d+[.)]\s+/, ""))}</li>`);
        i++;
      }
      htmlParts.push(`<ol class="md-ol">${items.join("")}</ol>`);
      continue;
    }

    const pLines = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^@@CODEBLOCK_\d+@@$/.test(lines[i].trim()) &&
      !/^(#{1,4})\s+/.test(lines[i].trim()) &&
      !/^(-{3,}|\*{3,}|_{3,})$/.test(lines[i].trim()) &&
      !/^[-*•]\s+/.test(lines[i].trim()) &&
      !/^\d+[.)]\s+/.test(lines[i].trim()) &&
      !lines[i].trim().startsWith(">") &&
      !(lines[i].trim().startsWith("|") && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1]))
    ) {
      pLines.push(renderInlineMarkdown(lines[i]));
      i++;
    }
    if (pLines.length) {
      htmlParts.push(`<p class="md-p" dir="auto">${pLines.join("<br/>")}</p>`);
    }
  }

  return htmlParts.join("");
}

