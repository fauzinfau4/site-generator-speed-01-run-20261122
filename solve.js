// Fast drop-in for makefun-site 1.0.0 — original implementation, written from the
// README + reference behaviour. Single-file, dependency-free ES module.
// Strategy: no per-character regex work in the hot paths — chunked inline
// rendering, a direct (token-free) Markdown renderer over the source lines,
// cached slugify with a fast ASCII path, and a flat template interpreter that
// appends to arrays instead of concatenating strings.

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const RESERVED = ['posts', 'tags', 'page'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_TEST = /[&<>"']/;
/** HTML-escape: one C++ regex scan; a clean chunk is returned untouched, no callback setup. */
function esc(s) {
  if (s.search(ESC_TEST) === -1) return s;
  return s.replace(ESC_RE, (c) => ESCAPES[c]);
}

function slugifyRaw(text) {
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    const code = ch.charCodeAt(0);
    let keep = null;
    if (code >= 65 && code <= 90) keep = ch.toLowerCase();
    else if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57)) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64);
  let e = out.length;
  while (e > 0 && out[e - 1] === '-') e--;
  out = out.slice(0, e);
  return out === '' ? 'untitled' : out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Count runs of non-whitespace, as /\S+/g would, without allocating the matches. */
function wordsOf(text) {
  let n = 0;
  let inW = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 || (c > 127 && /\s/.test(text[i]));
    if (ws) inW = false;
    else if (!inW) { inW = true; n++; }
  }
  return n;
}

/** wordsOf over a line range (joining the lines with '\n' would count the same). */
function wordsOfLines(lines, start, end) {
  let n = 0;
  for (let i = start; i < end; i++) n += wordsOf(lines[i]);
  return n;
}

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimTrailingST(line) {
  let e = line.length;
  while (e > 0) {
    const c = line.charCodeAt(e - 1);
    if (c !== 32 && c !== 9) break;
    e--;
  }
  return line.slice(0, e);
}

function trimLine(line) {
  let s = 0;
  let e = line.length;
  while (s < e && (line.charCodeAt(s) === 32 || line.charCodeAt(s) === 9)) s++;
  while (e > s && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return line.slice(s, e);
}

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) {
        tags[i] = tags[i].trim();
        const t = tags[i];
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let j = 0; j < t.length; j++) {
          const c = t[j];
          if (c === '"' || c === '[' || c === ']') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      let ok = raw.length >= 1 && raw.length <= 64;
      if (ok) {
        // /^[a-z0-9]+(?:-[a-z0-9]+)*$/
        let prevDash = true;
        for (let i = 0; i < raw.length; i++) {
          const c = raw.charCodeAt(i);
          if (c === 45) {
            if (prevDash) { ok = false; break; }
            prevDash = true;
          } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
          else { ok = false; break; }
        }
        if (prevDash) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Parse front matter from a source's lines; returns {data, close} or {error}. */
function parseFrontMatter(lines, nLines) {
  if (nLines === 0 || lines[0] !== '---') return { error: 'no front matter' };
  let close = -1;
  for (let i = 1; i < nLines; i++) {
    if (lines[i] === '---') { close = i; break; }
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 1; i < close; i++) {
    const line = lines[i];
    if (isBlankLine(line) || line.charCodeAt(0) === 35) continue;
    let k = 0;
    while (k < line.length) {
      const c = line.charCodeAt(k);
      if (!((c >= 97 && c <= 122) || c === 95)) break;
      k++;
    }
    if (k === 0 || k >= line.length || line.charCodeAt(k) !== 58) return { error: `line ${i + 1} is not "key: value"` };
    const key = line.slice(0, k);
    let raw;
    if (k + 1 === line.length) raw = '';
    else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
    else return { error: `line ${i + 1} is not "key: value"` };
    raw = trimTrailingST(raw);
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, close };
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const WS_RE = /\s/;

function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

/** Index of the next inline-special char (\, `, *, [) at or after `from`, or -1. */
const NS_RE = /[\\`*[]/;
function nextSpecial(s, from) {
  const i = s.slice(from).search(NS_RE);
  return i === -1 ? -1 : from + i;
}

/** Render `s` inline, appending chunks to `out`. `env.link(target)` resolves links. */
function inlineTo(s, env, out) {
  const n = s.length;
  let i = 0;
  while (i < n) {
    const j = nextSpecial(s, i);
    if (j === -1) { out.push(esc(s.slice(i))); break; }
    if (j > i) out.push(esc(s.slice(i, j)));
    const c = s[j];
    if (c === '\\') {
      if (j + 1 < n && ESCAPABLE.has(s[j + 1])) { out.push(esc(s[j + 1])); i = j + 2; }
      else { out.push('\\'); i = j + 1; }
    } else if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) { out.push('<code>'); out.push(esc(s.slice(j + 1, k))); out.push('</code>'); i = k + 1; }
      else { out.push('`'); i = j + 1; }
    } else if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) { out.push('<strong>'); inlineTo(s.slice(j + 2, k), env, out); out.push('</strong>'); i = k + 2; }
        else { out.push('**'); i = j + 2; }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) { out.push('<em>'); inlineTo(s.slice(j + 1, k), env, out); out.push('</em>'); i = k + 1; }
        else { out.push('*'); i = j + 1; }
      }
    } else {
      const k = findUnescaped(s, ']', j + 1);
      let m = -1;
      let target = '';
      if (k !== -1 && s[k + 1] === '(') {
        m = s.indexOf(')', k + 2);
        if (m !== -1) target = s.slice(k + 2, m);
      }
      if (m !== -1 && target !== '' && !WS_RE.test(target)) {
        out.push('<a href="');
        out.push(esc(env.link(target)));
        out.push('">');
        inlineTo(s.slice(j + 1, k), env, out);
        out.push('</a>');
        i = m + 1;
      } else { out.push('['); i = j + 1; }
    }
  }
}

function inlineStr(s, env) {
  const out = [];
  inlineTo(s, env, out);
  return out.join('');
}

function isLangChar(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 95 || code === 43 || code === 45;
}

/** Fence-open language of `line`, or null. */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let j = 3;
  while (j < line.length && isLangChar(line.charCodeAt(j))) j++;
  const langEnd = j;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  return j === line.length ? line.slice(3, langEnd) : null;
}

function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Heading {depth, text} of `line`, or null. */
function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null;
  let c = 0;
  while (c < line.length && line.charCodeAt(c) === 35) c++;
  if (c > 6) return null;
  if (c >= line.length) return null;
  const sp = line.charCodeAt(c);
  if (sp !== 32 && sp !== 9) return null;
  let j = c;
  while (j < line.length && (line.charCodeAt(j) === 32 || line.charCodeAt(j) === 9)) j++;
  if (j === line.length) return null;
  let e = line.length;
  while (e > j && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  return { depth: c, text: line.slice(j, e) };
}

function isHR(line) {
  const a = line.charCodeAt(0);
  const b = line.charCodeAt(1);
  const d = line.charCodeAt(2);
  if (!((a === 45 && b === 45 && d === 45) || (a === 42 && b === 42 && d === 42))) return false;
  for (let j = 3; j < line.length; j++) {
    const c = line.charCodeAt(j);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function endsParagraph(line) {
  return isBlankLine(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHR(line);
}

function bulletOf(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

function orderedOf(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
  if (j >= 1 && j <= 9 && line.charCodeAt(j) === 46 && line.charCodeAt(j + 1) === 32) {
    return { num: Number(line.slice(0, j)), rest: line.slice(j + 2) };
  }
  return null;
}

function continuedOf(line) {
  let c = 0;
  while (c < line.length && line.charCodeAt(c) === 32) c++;
  return c >= 2 && c < line.length && !WS_RE.test(line[c]);
}

/**
 * Render a body's lines (lines[start..end)) to {html, toc, excerpt}.
 * `slugify` is the case's cached slug function; `env` resolves links.
 * Blocks push straight into one chunk array (no per-block strings), except
 * where a string is needed (excerpt, toc entries, blockquotes).
 */
function renderMarkdown(lines, start, end, env, slugify) {
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  let i = start;
  while (i < end) {
    const line = lines[i];
    if (isBlankLine(line)) { i++; continue; }
    const fence = fenceOpen(line);
    if (fence !== null) {
      const body = [];
      i++;
      while (i < end && !fenceClose(lines[i])) body.push(lines[i++]);
      i++;
      out.push(fence === '' ? '<pre><code>' : `<pre><code class="language-${esc(fence)}">`);
      for (let b = 0; b < body.length; b++) { out.push(esc(body[b])); out.push('\n'); }
      out.push('</code></pre>\n');
      continue;
    }
    const h = headingOf(line);
    if (h !== null) {
      const id = uniqueSlug(slugify(h.text), ids);
      if (h.depth === 2 || h.depth === 3) {
        const html = inlineStr(h.text, env);
        toc.push({ level: h.depth, id, html });
        out.push(`<h${h.depth} id="${id}">`, html, `</h${h.depth}>\n`);
      } else {
        out.push(`<h${h.depth} id="${id}">`);
        inlineTo(h.text, env, out);
        out.push(`</h${h.depth}>\n`);
      }
      i++;
      continue;
    }
    if (isHR(line)) { out.push('<hr>\n'); i++; continue; }
    if (line.charCodeAt(0) === 62) {
      const q = [];
      while (i < end && lines[i].charCodeAt(0) === 62) {
        const l = lines[i];
        q.push(trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1)));
        i++;
      }
      const kept = q.filter((l) => l !== '');
      out.push(kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inlineStr(kept.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    }
    const b0 = bulletOf(line);
    const o0 = b0 === null ? orderedOf(line) : null;
    if (b0 !== null || o0 !== null) {
      const isOrd = o0 !== null;
      const startNum = isOrd ? o0.num : 1;
      const items = [];
      if (isOrd) items.push(trimLine(o0.rest));
      else items.push(trimLine(b0));
      i++;
      while (i < end) {
        const cur = lines[i];
        if (isOrd) {
          const m = orderedOf(cur);
          if (m !== null) { items.push(trimLine(m.rest)); i++; continue; }
        } else {
          const m = bulletOf(cur);
          if (m !== null) { items.push(trimLine(m)); i++; continue; }
        }
        if (continuedOf(cur)) { items[items.length - 1] += `\n${trimLine(cur)}`; i++; continue; }
        break;
      }
      const tag = isOrd ? 'ol' : 'ul';
      out.push(isOrd && startNum !== 1 ? `<ol start="${startNum}">` : `<${tag}>`, '\n');
      for (let k = 0; k < items.length; k++) {
        out.push('<li>');
        inlineTo(items[k], env, out);
        out.push('</li>\n');
      }
      out.push(`</${tag}>\n`);
      continue;
    }
    const parts = [trimLine(line)];
    i++;
    while (i < end && !endsParagraph(lines[i])) { parts.push(trimLine(lines[i])); i++; }
    const text = parts.join('\n');
    if (excerpt === null) {
      const html = inlineStr(text, env);
      excerpt = html;
      out.push('<p>', html, '</p>\n');
    } else {
      out.push('<p>');
      inlineTo(text, env, out);
      out.push('</p>\n');
    }
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;
const INCLUDE_DEPTH = 8;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** Tokenize a template source: text / var / raw / tag tokens, standalone {% %} lines taken whole. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 0, text });
      text = '';
      tokens.push({ t: raw ? 2 : 1, path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 0, text });
    text = '';
    tokens.push({ t: 3, tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 0, text });
  return tokens;
}

/** Parse a template into a node tree (k: 0 text, 1 var, 2 raw, 3 if, 4 for, 5 include). */
function parseTemplate(name, src) {
  const root = { k: 6, body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 0) body.push({ k: 0, text: tok.text });
    else if (tok.t === 1 || tok.t === 2) body.push({ k: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { k: 4, name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { k: 3, not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], els: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.k !== 3 || top.els !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.els = [];
        body = top.els;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.k !== (tag === 'endfor' ? 4 : 3)) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.k === 6 ? parent.body : parent.k === 4 ? parent.body : parent.els ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ k: 5, name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].k === 4 ? 'for' : 'if'} is not closed`);
  return root.body;
}

function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

function renderNodes(nodes, scope, ctx, depth, out) {
  for (let n = 0; n < nodes.length; n++) {
    const node = nodes[n];
    switch (node.k) {
      case 0:
        out.push(node.text);
        break;
      case 1:
        out.push(esc(textOf(lookup(scope, node.path))));
        break;
      case 2:
        out.push(textOf(lookup(scope, node.path)));
        break;
      case 3: {
        const v = truthy(lookup(scope, node.path));
        const branch = v !== node.not ? node.then : node.els;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 4: {
        const xs = lookup(scope, node.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = {};
          vars[node.name] = xs[k];
          vars.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
          renderNodes(node.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 5: {
        const t = ctx.templates.get(node.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- build

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** One site's output tree: path -> text. */
export function run(input) {
  const slugCache = new Map();
  const slugify = (text) => {
    const hit = slugCache.get(text);
    if (hit !== undefined) return hit;
    const s = slugifyRaw(text);
    slugCache.set(text, s);
    return s;
  };

  // Templates, parsed in code-unit order of name; failures reported and left out.
  const templates = new Map();
  const report = [];
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (const name of names) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }

  const base = input.site.base_url.replace(/\/+$/, '');
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, lines: f.content.replace(/\r\n?/g, '\n').split('\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter + refusal checks, in order.
  const kept = [];
  for (const s of sources) {
    const nLines = s.lines.length;
    const fm = parseFrontMatter(s.lines, nLines);
    if ('error' in fm) { report.push(`refused ${s.path}: ${fm.error}`); continue; }
    s.data = fm.data;
    s.bodyStart = fm.close + 1;
    s.post = s.path.startsWith('posts/');
    let own;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) { own = d; break; }
    }
    if (own !== undefined) { report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
    if (s.post && !Object.hasOwn(s.data, 'date')) { report.push(`refused ${s.path}: a post needs a date`); continue; }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) { report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
    s.layout = layout;
    if (s.data.draft === true) { report.push(`draft ${s.path}`); continue; }
    kept.push(s);
  }

  // Permalinks.
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown + links.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const srcPath = s.path;
    const env = {
      link: (target) => {
        const c0 = target.charCodeAt(0);
        if ((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122)) {
          for (let j = 1; j < target.length; j++) {
            const ch = target.charCodeAt(j);
            if (ch === 58) return target;
            if (!((ch >= 48 && ch <= 57) || (ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 43 || ch === 45 || ch === 46)) break;
          }
        }
        if (target[0] === '/' || target[0] === '#') return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${srcPath} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.lines, s.bodyStart, s.lines.length, env, slugify);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: posts newest first, equal dates by slug.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name)) ?? { name, slug: slugify(name), url: '', posts: [] });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards (computed once per source) and page records.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOfLines(s.lines, s.bodyStart, s.lines.length) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const s of kept) cards.set(s, cardOf(s));
  const pageOf = (s) => {
    const c = cards.get(s);
    return {
      title: c.title, url: c.url, date: c.date, date_long: c.date_long, summary: c.summary,
      excerpt: c.excerpt, reading_minutes: c.reading_minutes, tags: c.tags,
      slug: s.slug, content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  };

  // Layouts.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const baseScope = { vars: { site, tags: allTags, recent }, parent: null };
  const ctx = { templates };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, vars === null ? baseScope : { vars, parent: baseScope }, ctx, 0, out);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', null);
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // Report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const nPages = kept.filter((s) => !s.post).length;
  lines.push(`built ${nPages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

