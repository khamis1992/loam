function decodePercent(value) {
  return value.replace(/%([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function collapseConcat(value) {
  let current = value;
  let previous;
  do {
    previous = current;
    current = current.replace(/['"]\s*\+\s*['"]/g, '');
  } while (current !== previous);
  return current;
}

function commandForms(source) {
  const forms = new Set();
  let pending = [String(source)];
  for (let depth = 0; depth <= 2; depth += 1) {
    const layer = pending;
    pending = [];
    for (const value of layer) {
      const collapsed = collapseConcat(value);
      forms.add(value);
      forms.add(collapsed);
      forms.add(value.replace(/['"]/g, ''));
      forms.add(collapsed.replace(/['"]/g, ''));
      if (depth >= 2) continue;
      const decoded = decodePercent(value);
      const decodedCollapsed = decodePercent(collapsed);
      if (decoded !== value) pending.push(decoded);
      if (decodedCollapsed !== collapsed && decodedCollapsed !== decoded) pending.push(decodedCollapsed);
    }
  }
  return forms;
}

function installsPackage(source) {
  const pip = /(?:^|[^A-Za-z0-9_])(?:pip3?|pip\.exe)\s+install\b/i;
  const module = /(?:^|[^A-Za-z0-9_])(?:python(?:3|\.exe)?|py(?:\.exe)?)\s+-m\s+pip\s+install\b/i;
  const other = /(?:^|[^A-Za-z0-9_])(?:conda|micromamba)\s+install\b|(?:^|[^A-Za-z0-9_])uv\s+(?:add|pip\s+install)\b/i;
  const api = /(?:^|[^A-Za-z0-9_])pip\s*\.\s*main\s*\(|run_line_magic\s*\(\s*['"]pip['"]\s*,\s*['"]install\b/i;
  const listed = /\[\s*['"](?:pip3?|pip\.exe|conda|micromamba|uv)['"]\s*,\s*['"](?:install|add)['"]/i;
  const jsPm = /(?:^|[^A-Za-z0-9_])(?:npm\s+install|pnpm\s+add|yarn\s+add|bun\s+add)\b/i;
  for (const form of commandForms(source)) {
    if (pip.test(form) || module.test(form) || other.test(form) || api.test(form) || listed.test(form) || jsPm.test(form)) return true;
  }
  return false;
}

module.exports = { installsPackage };
