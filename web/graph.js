/*
 * pi-cardex 离线知识图谱浏览
 * 原生 JS，零依赖；作为经典脚本内联进导出页。
 * 结构：纯函数工具 → Markdown 解析（纯） → 力导向布局（纯） → 页面应用。
 */
(function () {
  'use strict';

  /* ================= 通用工具（纯函数，可在 Node 中测试） ================= */

  function clamp(v, min, max) {
    return v < min ? min : v > max ? max : v;
  }

  function hashString(str) {
    var h = 2166136261 >>> 0;
    str = String(str);
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function formatDate(iso, dateOnly) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    function p(n) {
      return (n < 10 ? '0' : '') + n;
    }
    var day = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
    if (dateOnly) return day;
    return day + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /* 链接安全判定：只放行 http(s) 外链、同页锚点和卡片路径。
   * 卡片正文里的 ../discussions/<id>.md#message-N 指向原始讨论记录；卡片文件在
   * cards/ 目录而本页在库根，因此把这一受限形态重定位为 discussions/<id>.md#message-N。 */
  function safeHref(raw) {
    var url = String(raw == null ? '' : raw).trim();
    if (!url || /[\\\u0000-\u001f\u007f]/.test(url)) return null;
    if (/^https?:\/\//i.test(url)) return { kind: 'external', href: url };
    if (url.charCodeAt(0) === 35) return { kind: 'anchor', href: url };
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) return null; /* javascript:、data:、mailto: 等 */
    if (url.indexOf('//') === 0) return null; /* 协议相对地址 */
    if (/[\u0000-\u001f\u007f]/.test(url)) return null;
    if (/^cards\/[a-zA-Z0-9_-]+\.md$/.test(url)) return { kind: 'relative', href: url };
    var disc = url.match(/^\.\.\/discussions\/([a-zA-Z0-9_-]+)\.md(#message-\d+)?$/);
    if (disc) return { kind: 'relative', href: 'discussions/' + disc[1] + '.md' + (disc[2] || '') };
    return null;
  }

  var NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

  function decodeEntities(s) {
    if (s.indexOf('&') === -1) return s;
    return s.replace(
      /&(amp|lt|gt|quot|apos|nbsp);|&#x([0-9a-fA-F]+);|&#(\d+);/g,
      function (m, name, hex, dec) {
        if (name) return NAMED_ENTITIES[name];
        var code = hex ? parseInt(hex, 16) : parseInt(dec, 10);
        if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return m;
        return String.fromCodePoint(code);
      }
    );
  }

  var RE_WORDCHAR = /[\p{L}\p{N}_-]/u;

  function slugify(text) {
    var out = '';
    var lower = String(text).toLowerCase();
    for (var i = 0; i < lower.length; i++) {
      var ch = lower.charAt(i);
      if (RE_WORDCHAR.test(ch)) out += ch;
      else if (/\s/.test(ch)) out += '-';
    }
    out = out.replace(/-+/g, '-').replace(/^-|-$/g, '');
    return out || 'section';
  }

  /* 标题按“字宽单位”折行（1 单位 ≈ 一个 CJK 字符宽度），超出行数以省略号收尾 */
  function charUnits(code) {
    if (code >= 0x2e80) return 1; /* CJK、全角 */
    if (code >= 0x2000 && code <= 0x206f) return 1; /* ——、…… 等通用标点 */
    if (code < 0x80) return 0.56;
    return 0.9;
  }

  function wrapTitleText(title, maxUnits, maxLines) {
    var chars = Array.from(String(title == null ? '' : title));
    var lines = [];
    var cur = '';
    var curU = 0;
    for (var i = 0; i < chars.length; i++) {
      var ch = chars[i];
      if (ch === '\n') {
        lines.push(cur);
        cur = '';
        curU = 0;
        if (lines.length >= maxLines) return { lines: lines.slice(0, maxLines) };
        continue;
      }
      var u = charUnits(ch.codePointAt(0));
      if (curU + u > maxUnits - 0.01) {
        if (lines.length === maxLines - 1) {
          var last = cur;
          if (last) {
            if (curU + 1 > maxUnits - 0.01) last = last.slice(0, -1);
            last += '…';
          } else {
            last = ch;
          }
          lines.push(last);
          return { lines: lines };
        }
        lines.push(cur);
        cur = '';
        curU = 0;
      }
      cur += ch;
      curU += u;
    }
    lines.push(cur);
    return { lines: lines.slice(0, maxLines) };
  }

  /* ================= Markdown 解析（纯函数，输出块/行内 token 树） ================= */

  var RE_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
  var RE_FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;
  var RE_HEADING = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
  var RE_HR = /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
  var RE_QUOTE = /^ {0,3}>/;
  var RE_QUOTE_STRIP = /^ {0,3}> ?/;
  var RE_LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(.*)$/;
  var RE_INDENT = /^(\s*)/;

  function mdParse(src) {
    var text = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
    /* 跳过文档开头的 YAML frontmatter（卡片由 pi-cardex 自动写入 id/title 等元数据） */
    var fm = /^---[ \t]*\n[\s\S]*?\n---[ \t]*(?:\n|$)/.exec(text);
    if (fm) text = text.slice(fm[0].length);
    var lines = text.split('\n');
    var blocks = [];
    var i = 0;
    var len = lines.length;

    while (i < len) {
      var line = lines[i];
      if (!line || !line.trim()) {
        i++;
        continue;
      }

      var m = RE_FENCE.exec(line);
      if (m) {
        var ch = m[1].charAt(0);
        var n = m[1].length;
        var info = m[2].trim();
        var code = [];
        i++;
        while (i < len) {
          var cm = RE_FENCE_CLOSE.exec(lines[i]);
          if (cm && cm[1].charAt(0) === ch && cm[1].length >= n) {
            i++;
            break;
          }
          code.push(lines[i]);
          i++;
        }
        blocks.push({
          type: 'code',
          lang: info ? info.split(/\s+/)[0] : '',
          text: code.join('\n'),
        });
        continue;
      }

      m = RE_HEADING.exec(line);
      if (m) {
        blocks.push({ type: 'heading', level: m[1].length, text: m[2] });
        i++;
        continue;
      }

      if (RE_HR.test(line)) {
        blocks.push({ type: 'hr' });
        i++;
        continue;
      }

      if (RE_QUOTE.test(line)) {
        var quoted = [];
        while (i < len && RE_QUOTE.test(lines[i])) {
          quoted.push(lines[i].replace(RE_QUOTE_STRIP, ''));
          i++;
        }
        blocks.push({ type: 'quote', children: mdParse(quoted.join('\n')) });
        continue;
      }

      if (RE_LIST_ITEM.test(line)) {
        i = parseListBlock(lines, i, blocks);
        continue;
      }

      /* 段落：收集到空行或其他块级语法为止 */
      var para = [line];
      i++;
      while (i < len) {
        var pl = lines[i];
        if (!pl || !pl.trim()) break;
        if (
          RE_FENCE.test(pl) ||
          RE_HEADING.test(pl) ||
          RE_HR.test(pl) ||
          RE_QUOTE.test(pl) ||
          RE_LIST_ITEM.test(pl)
        ) {
          break;
        }
        para.push(pl);
        i++;
      }
      blocks.push({ type: 'paragraph', text: para.join('\n') });
    }
    return blocks;
  }

  function parseListBlock(lines, i, blocks) {
    var len = lines.length;
    var first = RE_LIST_ITEM.exec(lines[i]);
    var baseIndent = first[1].length;
    var ordered = /\d/.test(first[2]);
    var start = ordered ? parseInt(first[2], 10) : 1;
    var items = [];

    while (i < len) {
      var line = lines[i];
      if (!line || !line.trim()) {
        /* 空行后若还是列表项则继续（松散列表），否则结束 */
        var j = i + 1;
        while (j < len && !lines[j].trim()) j++;
        if (j < len && RE_LIST_ITEM.test(lines[j]) && RE_INDENT.exec(lines[j])[1].length <= baseIndent + 1) {
          i = j;
          continue;
        }
        break;
      }
      var m = RE_LIST_ITEM.exec(line);
      var indent = m ? m[1].length : -1;
      if (!m || indent > baseIndent + 1) break; /* 更深的内容已由上一项收走 */

      var contentCol = indent + m[2].length + m[3].length;
      var itemLines = [m[4]];
      i++;
      while (i < len) {
        var nl = lines[i];
        if (!nl || !nl.trim()) {
          /* 空行后若有属于本项的缩进内容，则并入 */
          var k = i + 1;
          while (k < len && !lines[k].trim()) k++;
          if (k < len && RE_INDENT.exec(lines[k])[1].length >= contentCol) {
            while (i < k) {
              itemLines.push('');
              i++;
            }
            continue;
          }
          break;
        }
        var nIndent = RE_INDENT.exec(nl)[1].length;
        if (nIndent >= contentCol) {
          itemLines.push(nl.slice(contentCol));
          i++;
        } else {
          break;
        }
      }
      items.push({ blocks: mdParse(itemLines.join('\n')) });
    }

    blocks.push({ type: 'list', ordered: ordered, start: start, items: items });
    return i;
  }

  /* ---------- 行内词法 ---------- */

  var RE_ESCAPABLE = /^[\p{P}\p{S}]$/u;
  var RE_AUTOLINK = /^<(https?:\/\/[^<>\s]+)>/;

  function parseLinkAt(s, i) {
    /* s[i] === '['，返回 { text, url, next } 或 null */
    var depth = 1;
    var j = i + 1;
    for (; j < s.length; j++) {
      var c = s.charAt(j);
      if (c === '\\') {
        j++;
        continue;
      }
      if (c === '[') depth++;
      else if (c === ']') {
        depth--;
        if (!depth) break;
      }
    }
    if (depth || j >= s.length) return null;
    if (s.charAt(j + 1) !== '(') return null;
    var paren = 1;
    var k = j + 2;
    for (; k < s.length; k++) {
      var pc = s.charAt(k);
      if (pc === '\\') {
        k++;
        continue;
      }
      if (pc === '(') paren++;
      else if (pc === ')') {
        paren--;
        if (!paren) break;
      }
    }
    if (paren || k >= s.length) return null;
    var url = s.slice(j + 2, k).trim();
    if (!url) return null;
    if (url.charAt(0) === '<' && url.charAt(url.length - 1) === '>') url = url.slice(1, -1);
    var tm = /^(\S+)(?:\s+["'“].*)?$/.exec(url);
    if (!tm) return null;
    url = tm[1];
    if (/[\s<>]/.test(url)) return null;
    return { text: s.slice(i + 1, j), url: url, next: k + 1 };
  }

  function scanInline(s, out) {
    var buf = '';
    function flush() {
      if (buf) {
        out.push({ type: 'text', text: decodeEntities(buf) });
        buf = '';
      }
    }
    var i = 0;
    var len = s.length;
    while (i < len) {
      var c = s.charAt(i);

      if (c === '\\' && i + 1 < len && RE_ESCAPABLE.test(s.charAt(i + 1))) {
        buf += s.charAt(i + 1);
        i += 2;
        continue;
      }

      if (c === '`') {
        var n = 1;
        while (s.charAt(i + n) === '`') n++;
        var close = -1;
        var search = i + n;
        while (search < len) {
          var cj = s.indexOf('`', search);
          if (cj < 0) break;
          var cn = 1;
          while (s.charAt(cj + cn) === '`') cn++;
          if (cn === n) {
            close = cj;
            break;
          }
          search = cj + cn;
        }
        if (close >= 0) {
          var codeText = s.slice(i + n, close).replace(/\n/g, ' ');
          if (
            codeText.length >= 2 &&
            codeText.charAt(0) === ' ' &&
            codeText.charAt(codeText.length - 1) === ' ' &&
            codeText.trim()
          ) {
            codeText = codeText.slice(1, -1);
          }
          flush();
          out.push({ type: 'code', text: codeText });
          i = close + n;
          continue;
        }
        buf += s.slice(i, i + n);
        i += n;
        continue;
      }

      if (c === '*' || c === '_' || c === '~') {
        var run = 1;
        while (s.charAt(i + run) === c) run++;
        if (c === '~' && run !== 2) {
          buf += s.slice(i, i + run);
          i += run;
          continue;
        }
        var canOpen = i + run < len && !/\s/.test(s.charAt(i + run));
        if (c === '_') {
          /* 下划线强调不吞掉 snake_case */
          canOpen =
            canOpen && (i === 0 || !/[\p{L}\p{N}]/u.test(s.charAt(i - 1)));
        }
        var closer = -1;
        var t = i + run;
        while (t < len) {
          if (s.charAt(t) === c) {
            var tr = 1;
            while (s.charAt(t + tr) === c) tr++;
            if (tr === run && !/\s/.test(s.charAt(t - 1))) {
              closer = t;
              break;
            }
            t += tr;
          } else {
            t++;
          }
        }
        if (closer > i + run && canOpen) {
          flush();
          var inner = [];
          scanInline(s.slice(i + run, closer), inner);
          var type = c === '~' ? 'del' : run >= 2 ? 'strong' : 'em';
          out.push({ type: type, children: inner });
          i = closer + run;
          continue;
        }
        buf += s.slice(i, i + run);
        i += run;
        continue;
      }

      if (c === '!' && s.charAt(i + 1) === '[') {
        var img = parseLinkAt(s, i + 1);
        if (img) {
          flush();
          var altToks = [];
          scanInline(img.text, altToks);
          out.push({ type: 'img', alt: textOfTokens(altToks).trim(), url: img.url });
          i = img.next;
          continue;
        }
      }

      if (c === '[') {
        var link = parseLinkAt(s, i);
        if (link) {
          flush();
          var kids = [];
          scanInline(link.text, kids);
          out.push({ type: 'link', url: link.url, children: kids });
          i = link.next;
          continue;
        }
      }

      if (c === '<' && s.startsWith('<!--', i)) {
        /* 隐藏卡片内部的 record 标记等 HTML 注释；未闭合则按原样展示 */
        var ce = s.indexOf('-->', i + 4);
        if (ce >= 0) {
          i = ce + 3;
          continue;
        }
      }

      if (c === '<') {
        var am = RE_AUTOLINK.exec(s.slice(i));
        if (am) {
          flush();
          out.push({
            type: 'link',
            url: am[1],
            children: [{ type: 'text', text: am[1] }],
          });
          i += am[0].length;
          continue;
        }
      }

      buf += c;
      i++;
    }
    flush();
  }

  function textOfTokens(tokens) {
    var out = '';
    (tokens || []).forEach(function (t) {
      if (t.type === 'text' || t.type === 'code') out += t.text;
      else if (t.type === 'img') out += t.alt;
      else if (t.children) out += textOfTokens(t.children);
    });
    return out;
  }

  function inlinePlain(text) {
    var toks = [];
    scanInline(String(text), toks);
    return textOfTokens(toks).trim();
  }

  /* ---------- 阅读投影（纯函数：批次校验 / 标题 ID 命名空间 / 锚点解析） ---------- */

  /** 与文档首部标题同名时跳过该标题（卡片正文以 H1 开头，详情栏已单独展示标题）。 */
  function applySkipTitle(blocks, skipTitle) {
    var list = Array.isArray(blocks) ? blocks : [];
    if (!skipTitle || !list.length || list[0].type !== 'heading') return list;
    var plain = inlinePlain(list[0].text);
    var target = String(skipTitle).trim();
    if (plain === target || plain.toLowerCase() === target.toLowerCase()) return list.slice(1);
    return list;
  }

  /**
   * 渲染前为标题块分配 DOM ID：同一文档内重名标题追加 -2 后缀，与旧渲染一致；
   * 命名空间（ns）隔离多个批次的标题 ID，并把「原始 slug → 最终 ID」登记进
   * anchorMap（先到先得），供正文里的 #锚点 链接解析。
   */
  function prepareHeadingIds(blocks, ns, usedIds, anchorMap) {
    var list = Array.isArray(blocks) ? blocks : [];
    var prefix = ns ? ns + '-' : '';
    list.forEach(function (b) {
      if (b.type === 'heading') {
        var base = slugify(inlinePlain(b.text));
        var id = base;
        var n = 2;
        while (usedIds[id]) id = base + '-' + n++;
        usedIds[id] = true;
        b.id = prefix + id;
        if (anchorMap && !anchorMap.has(base)) anchorMap.set(base, b.id);
        if (anchorMap && !anchorMap.has(id)) anchorMap.set(id, b.id);
      } else if (b.type === 'quote') {
        prepareHeadingIds(b.children, ns, usedIds, anchorMap);
      } else if (b.type === 'list') {
        (b.items || []).forEach(function (item) {
          prepareHeadingIds(item.blocks || [], ns, usedIds, anchorMap);
        });
      }
    });
  }

  /** 锚点解析：先精确匹配，再按 slug 规则匹配；未命中返回 null（调用方转为纯文本，不产生错误导航）。 */
  function resolveAnchor(fragment, anchorMap) {
    if (!anchorMap || !fragment) return null;
    var f = String(fragment);
    if (anchorMap.has(f)) return anchorMap.get(f);
    var slug = slugify(decodeEntities(f));
    return anchorMap.has(slug) ? anchorMap.get(slug) : null;
  }

  /**
   * 校验导出时派生的 reading 字段：结构不完整或没有批次时返回 null，
   * 调用方回退到完整 Markdown 渲染，正文不会丢失。
   */
  function normalizeReading(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    var introduction = raw.introduction == null ? '' : raw.introduction;
    if (typeof introduction !== 'string') return null;
    if (!Array.isArray(raw.records) || !raw.records.length) return null;
    var records = [];
    for (var i = 0; i < raw.records.length; i++) {
      var r = raw.records[i];
      if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
      var rec = {
        id: r.id == null ? '' : r.id,
        archivedAt: r.archivedAt == null ? '' : r.archivedAt,
        organizer: r.organizer == null ? '' : r.organizer,
        titles: [],
        content: r.content,
        transcript: r.transcript == null ? '' : r.transcript,
      };
      if (
        typeof rec.id !== 'string' ||
        typeof rec.archivedAt !== 'string' ||
        typeof rec.organizer !== 'string' ||
        typeof rec.transcript !== 'string'
      ) {
        return null;
      }
      if (typeof rec.content !== 'string' || !rec.content.trim()) return null;
      var titles = r.titles == null ? [] : r.titles;
      if (!Array.isArray(titles)) return null;
      for (var j = 0; j < titles.length; j++) {
        if (typeof titles[j] !== 'string') return null;
        if (titles[j]) rec.titles.push(titles[j]);
      }
      records.push(rec);
    }
    return { introduction: introduction, records: records };
  }

  /**
   * 由 reading 构建分批渲染视图：每个文档（前言 / 各批正文 / 各批原文）
   * 独立命名空间与局部锚点表；全局表按出现先后聚合，供跨批锚点解析。
   */
  function buildReadingViews(node) {
    var reading = node && node.reading ? normalizeReading(node.reading) : null;
    var out = { reading: reading, docs: [], anchorMap: null };
    if (!reading) return out;
    var globalMap = new Map();
    function addDoc(kind, ns, blocks, index, record) {
      var local = new Map();
      prepareHeadingIds(blocks, ns, {}, local);
      local.forEach(function (id, base) {
        if (!globalMap.has(base)) globalMap.set(base, id);
      });
      out.docs.push({
        kind: kind,
        ns: ns,
        blocks: blocks,
        index: index,
        record: record || null,
        anchorMap: local,
      });
    }
    var introBlocks = applySkipTitle(mdParse(reading.introduction), node && node.title);
    if (introBlocks.length) addDoc('intro', 'intro', introBlocks, 0, null);
    reading.records.forEach(function (r, i) {
      var ns = 'r' + (i + 1);
      addDoc('content', ns, mdParse(r.content), i, r);
      if (r.transcript && r.transcript.trim()) {
        addDoc('transcript', ns + 't', mdParse(r.transcript), i, r);
      }
    });
    out.anchorMap = globalMap;
    return out;
  }


  /* ---------- DOM 渲染（仅浏览器执行；全部通过 createElement/textContent 构建，不拼 HTML） ---------- */

  function renderMarkdown(src, opts) {
    opts = opts || {};
    var blocks = applySkipTitle(mdParse(src), opts.skipTitle);
    var local = new Map();
    prepareHeadingIds(blocks, opts.ns, {}, local);
    return renderBlocks(blocks, { anchors: local, globalAnchors: null });
  }

  /** 渲染已解析的块列表；ctx 携带锚点表（anchors：本文档，globalAnchors：整张卡）。 */
  function renderBlocks(blocks, ctx) {
    var root = document.createElement('div');
    root.className = 'md';
    var list = Array.isArray(blocks) ? blocks : [];
    for (var bi = 0; bi < list.length; bi++) {
      appendBlock(root, list[bi], ctx);
    }
    return root;
  }

  function appendBlock(parent, b, ctx) {
    var el;
    if (b.type === 'heading') {
      el = document.createElement('h' + clamp(b.level, 1, 6));
      el.id = b.id || slugify(inlinePlain(b.text));
      renderInlines(b.text, el, ctx);
    } else if (b.type === 'paragraph') {
      el = document.createElement('p');
      renderInlines(b.text, el, ctx);
      if (!el.firstChild) el = null; /* 整段只有注释时不输出空段落 */
    } else if (b.type === 'code') {
      el = document.createElement('pre');
      if (b.lang) el.setAttribute('data-lang', b.lang);
      var code = document.createElement('code');
      code.textContent = b.text;
      el.appendChild(code);
    } else if (b.type === 'quote') {
      el = document.createElement('blockquote');
      b.children.forEach(function (child) {
        appendBlock(el, child, ctx);
      });
    } else if (b.type === 'hr') {
      el = document.createElement('hr');
    } else if (b.type === 'list') {
      el = document.createElement(b.ordered ? 'ol' : 'ul');
      if (b.ordered && b.start !== 1) el.setAttribute('start', String(b.start));
      b.items.forEach(function (item) {
        var li = document.createElement('li');
        var bs = item.blocks || [];
        bs.forEach(function (ib, idx) {
          if (idx === 0 && ib.type === 'paragraph') renderInlines(ib.text, li, ctx);
          else appendBlock(li, ib, ctx);
        });
        el.appendChild(li);
      });
    }
    if (el) parent.appendChild(el);
  }

  function renderInlines(text, parent, ctx) {
    var tokens = [];
    scanInline(String(text), tokens);
    appendTokens(tokens, parent, ctx);
  }

  function appendTokens(tokens, parent, ctx) {
    tokens.forEach(function (t) {
      if (t.type === 'text') {
        parent.appendChild(document.createTextNode(t.text));
      } else if (t.type === 'code') {
        var code = document.createElement('code');
        code.textContent = t.text;
        parent.appendChild(code);
      } else if (t.type === 'strong' || t.type === 'em' || t.type === 'del') {
        var el = document.createElement(t.type === 'strong' ? 'strong' : t.type === 'em' ? 'em' : 'del');
        appendTokens(t.children, el, ctx);
        parent.appendChild(el);
      } else if (t.type === 'img') {
        /* 离线页面不加载任何图片：改为文字说明，外链附“查看” */
        var note = document.createElement('span');
        note.className = 'md-img-note';
        note.textContent = '图片：' + (t.alt || '（无描述）');
        var ih = safeHref(t.url);
        if (ih && ih.kind === 'external') {
          note.appendChild(document.createTextNode(' '));
          var ia = document.createElement('a');
          ia.href = ih.href;
          ia.target = '_blank';
          ia.rel = 'noopener noreferrer';
          ia.textContent = '查看';
          note.appendChild(ia);
        }
        parent.appendChild(note);
      } else if (t.type === 'link') {
        var href = safeHref(t.url);
        if (!href) {
          appendTokens(t.children, parent, ctx);
          parent.appendChild(document.createTextNode('（链接未允许，已转为文字）'));
          return;
        }
        if (href.kind === 'anchor' && ctx) {
          /* 锚点先解析到本批（文档）标题，再查整张卡的全局表；
           * 未命中则退回纯文本，不产生错误跳转 */
          var frag = href.href.slice(1);
          var rid = resolveAnchor(frag, ctx.anchors) || resolveAnchor(frag, ctx.globalAnchors);
          if (!rid) {
            appendTokens(t.children, parent, ctx);
            return;
          }
          var aa = document.createElement('a');
          aa.href = '#' + rid;
          appendTokens(t.children, aa, ctx);
          parent.appendChild(aa);
          return;
        }
        var a = document.createElement('a');
        a.href = href.href;
        if (href.kind === 'external') {
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
        }
        appendTokens(t.children, a, ctx);
        parent.appendChild(a);
      }
    });
  }


  /* ================= 层级结构与树布局（确定性，纯函数） ================= */

  var MAX_TREE_DEPTH = 64; /* 防御性深度上限；正常数据不超过三级 */

  /**
   * 由扁平节点构建单父层级：
   * - parentId 指向缺失节点或自身时视为根；
   * - 父链成环时环上节点全部提升为根，保证每个节点可达且深度有限；
   * - childrenOf 与 roots 按标题排序，布局与树顺序稳定。
   */
  function buildHierarchy(list) {
    var src = Array.isArray(list) ? list : [];
    var ids = new Set();
    var titleOf = new Map();
    src.forEach(function (n) {
      if (!n || typeof n.id !== 'string') return;
      ids.add(n.id);
      titleOf.set(n.id, typeof n.title === 'string' ? n.title : n.id);
    });

    var parentOf = new Map();
    ids.forEach(function (id) {
      parentOf.set(id, null);
    });
    src.forEach(function (n) {
      if (!ids.has(n.id)) return;
      var p = n.parentId;
      if (typeof p === 'string' && p !== n.id && ids.has(p)) parentOf.set(n.id, p);
    });

    /* 环检测：沿父链上溯，回到当前路径内的节点即成环 */
    var state = new Map(); /* 0 未访问 1 路径中 2 已完成 */
    ids.forEach(function (id) {
      state.set(id, 0);
    });
    var detached = [];
    ids.forEach(function (start) {
      if (state.get(start) !== 0) return;
      var path = [];
      var posInPath = new Map();
      var cur = start;
      while (cur != null && state.get(cur) === 0) {
        state.set(cur, 1);
        posInPath.set(cur, path.length);
        path.push(cur);
        cur = parentOf.get(cur);
      }
      if (cur != null && state.get(cur) === 1) {
        for (var i = posInPath.get(cur); i < path.length; i++) {
          parentOf.set(path[i], null);
          detached.push(path[i]);
        }
      }
      path.forEach(function (id2) {
        state.set(id2, 2);
        posInPath.delete(id2);
      });
    });

    var byTitle = function (a, b) {
      return titleOf.get(a).localeCompare(titleOf.get(b), 'zh-Hans-CN', { numeric: true });
    };

    var childrenOf = new Map();
    ids.forEach(function (id) {
      childrenOf.set(id, []);
    });
    var roots = [];
    ids.forEach(function (id) {
      var p = parentOf.get(id);
      if (p == null) roots.push(id);
      else childrenOf.get(p).push(id);
    });
    roots.sort(byTitle);
    childrenOf.forEach(function (arr) {
      arr.sort(byTitle);
    });

    /* 深度：从根向下标记 */
    var depthOf = new Map();
    var queue = roots.slice();
    roots.forEach(function (r) {
      depthOf.set(r, 0);
    });
    while (queue.length) {
      var id3 = queue.shift();
      var d = depthOf.get(id3);
      var kids = childrenOf.get(id3) || [];
      for (var j = 0; j < kids.length; j++) {
        if (!depthOf.has(kids[j])) {
          depthOf.set(kids[j], d + 1);
          queue.push(kids[j]);
        }
      }
    }
    ids.forEach(function (id4) {
      if (!depthOf.has(id4)) depthOf.set(id4, 0);
    });

    return {
      parentOf: parentOf,
      childrenOf: childrenOf,
      roots: roots,
      depthOf: depthOf,
      detached: detached,
    };
  }

  /** 树搜索：命中节点及其全部祖先可见；命中节点的祖先强制展开。 */
  function treeQuery(ids, parentOf, match) {
    var list = Array.isArray(ids) ? ids : [];
    var hitIds = new Set();
    list.forEach(function (id) {
      if (match(id)) hitIds.add(id);
    });
    var visible = new Set(hitIds);
    var expand = new Set();
    hitIds.forEach(function (id) {
      var p = parentOf.get(id) || null;
      var guard = 0;
      while (p != null && guard++ < MAX_TREE_DEPTH) {
        visible.add(p);
        expand.add(p);
        p = parentOf.get(p) || null;
      }
    });
    return { hitIds: hitIds, visible: visible, expand: expand };
  }

  /**
   * 层级树布局（自上而下）：
   * - 同一深度共享水平带，带间留 levelGap；
   * - 兄弟子树按范围依次排布，父节点居中于首末子节点之间；
   * - 输入确定时输出确定，兄弟与跨子树的节点框互不重叠。
   */
  function computeTreeLayout(roots, childrenOf, sizeOf, opts) {
    opts = opts || {};
    var siblingGap = typeof opts.siblingGap === 'number' ? opts.siblingGap : 24;
    var levelGap = typeof opts.levelGap === 'number' ? opts.levelGap : 84;
    var rootGap = typeof opts.rootGap === 'number' ? opts.rootGap : siblingGap * 2;
    var size = typeof sizeOf === 'function' ? sizeOf : function () { return { w: 158, h: 40 }; };
    function sizeOfId(id) {
      var s = size(id) || {};
      var w = typeof s.w === 'number' && isFinite(s.w) && s.w > 0 ? s.w : 158;
      var h = typeof s.h === 'number' && isFinite(s.h) && s.h > 0 ? s.h : 40;
      return { w: w, h: h };
    }

    var pos = new Map();
    var rootList = (Array.isArray(roots) ? roots : []).filter(function (r) {
      return typeof r === 'string';
    });
    if (!rootList.length) return pos;

    /* 深度与各层最大高度（BFS，重复出现的节点按最浅层处理） */
    var depth = new Map();
    var stack = [];
    rootList.forEach(function (r) {
      stack.push([r, 0]);
    });
    while (stack.length) {
      var fr = stack.pop();
      var fid = fr[0];
      var fd = fr[1];
      if (depth.has(fid) || fd > MAX_TREE_DEPTH) continue;
      depth.set(fid, fd);
      var kids = (childrenOf && childrenOf.get(fid)) || [];
      for (var k = 0; k < kids.length; k++) stack.push([kids[k], fd + 1]);
    }
    var maxDepth = 0;
    depth.forEach(function (d) {
      if (d > maxDepth) maxDepth = d;
    });
    var levelH = [];
    depth.forEach(function (d, id) {
      var h = sizeOfId(id).h;
      if (!levelH[d] || h > levelH[d]) levelH[d] = h;
    });
    var bandY = [(levelH[0] || 40) / 2];
    for (var d2 = 1; d2 <= maxDepth; d2++) {
      bandY[d2] = bandY[d2 - 1] + (levelH[d2 - 1] || 40) / 2 + levelGap + (levelH[d2] || 40) / 2;
    }

    /* 水平排布：子树依次占位，返回范围 */
    function place(id, left, d) {
      var s = sizeOfId(id);
      var kids = ((childrenOf && childrenOf.get(id)) || []).filter(function (c) {
        return depth.get(c) === d + 1;
      });
      if (!kids.length || d >= MAX_TREE_DEPTH) {
        pos.set(id, { x: left + s.w / 2, y: bandY[d] });
        return { left: left, right: left + s.w };
      }
      var cursor = left;
      var firstX = 0;
      var lastX = 0;
      var minL = Infinity;
      var maxR = -Infinity;
      kids.forEach(function (c, i) {
        var r = place(c, cursor, d + 1);
        cursor = r.right + siblingGap;
        var cx = pos.get(c).x;
        if (i === 0) firstX = cx;
        lastX = cx;
        if (r.left < minL) minL = r.left;
        if (r.right > maxR) maxR = r.right;
      });
      var x = (firstX + lastX) / 2;
      pos.set(id, { x: x, y: bandY[d] });
      var l = x - s.w / 2;
      var r2 = x + s.w / 2;
      return { left: minL < l ? minL : l, right: maxR > r2 ? maxR : r2 };
    }

    var cursor2 = 0;
    rootList.forEach(function (r) {
      if (!depth.has(r)) return;
      var res = place(r, cursor2, 0);
      cursor2 = res.right + rootGap;
    });
    return pos;
  }

  /* ================= 页面应用 ================= */

  var SVG_NS = 'http://www.w3.org/2000/svg';
  var NODE_W = 158;
  var LABEL_MAX_UNITS = 10.4;
  var K_MIN = 0.15;
  var K_MAX = 4;
  var LAYOUT_OPTS = { siblingGap: 26, levelGap: 88 };

  function svgMake(name, attrs) {
    var e = document.createElementNS(SVG_NS, name);
    if (attrs) {
      for (var k in attrs) e.setAttribute(k, attrs[k]);
    }
    return e;
  }

  function div(className, text) {
    var e = document.createElement('div');
    if (className) e.className = className;
    if (text != null) e.textContent = text;
    return e;
  }

  function init() {
    var dataEl = document.getElementById('cardex-data');
    var raw = (dataEl && dataEl.textContent) || '';
    var data = null;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      data = null;
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.nodes)) {
      var placeholderName = '__PI_CARDEX' + '_DATA__';
      var isTemplate = raw.trim().indexOf(placeholderName) === 0;
      showFatal(
        isTemplate
          ? '这个页面是模板，还没有注入图谱数据。请先由 pi-cardex 导出生成可浏览的 HTML，再打开导出的文件。'
          : '页面里的图谱数据无法解析。请重新用 pi-cardex 导出本页后再打开。'
      );
      return;
    }

    /* ---- 数据准备（兼容缺 kind/parentId 的 version 1 数据） ---- */
    var nodes = [];
    var seen = new Set();
    data.nodes.forEach(function (n) {
      if (!n || typeof n.id !== 'string' || typeof n.title !== 'string') return;
      if (seen.has(n.id)) return;
      seen.add(n.id);
      nodes.push({
        id: n.id,
        kind: n.kind === 'group' ? 'group' : 'knowledge',
        parentId: typeof n.parentId === 'string' ? n.parentId : null,
        title: n.title,
        summary: typeof n.summary === 'string' ? n.summary : '',
        file: typeof n.file === 'string' ? n.file : '',
        markdown: typeof n.markdown === 'string' ? n.markdown : '',
        entryCount: typeof n.entryCount === 'number' ? n.entryCount : 0,
        createdAt: typeof n.createdAt === 'string' ? n.createdAt : '',
        updatedAt: typeof n.updatedAt === 'string' ? n.updatedAt : '',
        reading: normalizeReading(n.reading),
      });
    });

    if (!nodes.length) {
      document.body.classList.add('is-empty');
      document.getElementById('layout').hidden = true;
      document.getElementById('empty').hidden = false;
      return;
    }

    var nodeById = new Map();
    nodes.forEach(function (n) {
      nodeById.set(n.id, n);
    });

    var hierarchy = buildHierarchy(nodes);
    var allIds = nodes.map(function (n) {
      return n.id;
    });

    var edges = [];
    var edgeSeen = new Set();
    (Array.isArray(data.edges) ? data.edges : []).forEach(function (e) {
      if (!e || typeof e.source !== 'string' || typeof e.target !== 'string') return;
      if (e.source === e.target) return;
      if (!nodeById.has(e.source) || !nodeById.has(e.target)) return;
      var relation = typeof e.relation === 'string' ? e.relation : '';
      var reason = typeof e.reason === 'string' ? e.reason : '';
      var a = e.source < e.target ? e.source : e.target;
      var b = e.source < e.target ? e.target : e.source;
      var key = a + '\u0000' + b + '\u0000' + relation;
      if (edgeSeen.has(key)) return;
      edgeSeen.add(key);
      edges.push({ source: e.source, target: e.target, relation: relation, reason: reason });
    });

    /* 语义关联（与父子层级无关） */
    var adjacency = new Map();
    nodes.forEach(function (n) {
      adjacency.set(n.id, new Set());
    });
    edges.forEach(function (e) {
      adjacency.get(e.source).add(e.target);
      adjacency.get(e.target).add(e.source);
    });

    /* ---- DOM 引用 ---- */
    var searchInput = document.getElementById('search');
    var genEl = document.getElementById('gen-time');
    var treeEl = document.getElementById('node-tree');
    var listScroll = document.getElementById('list-scroll');
    var listCount = document.getElementById('list-count');
    var listEmpty = document.getElementById('list-empty');
    var svg = document.getElementById('graph');
    var viewport = document.getElementById('viewport');
    var edgeLayer = document.getElementById('edge-layer');
    var nodeLayer = document.getElementById('node-layer');
    var labelLayer = document.getElementById('label-layer');
    var detailEl = document.getElementById('detail');
    var detailScroll = document.querySelector('.detail-scroll');
    var liveEl = document.getElementById('live');
    var zoomInBtn = document.getElementById('zoom-in');
    var zoomOutBtn = document.getElementById('zoom-out');
    var fitBtn = document.getElementById('zoom-fit');
    var relayoutBtn = document.getElementById('relayout');
    var graphToggle = document.getElementById('graph-toggle');
    var graphPane = document.querySelector('.graph-pane');

    if (data.generatedAt) {
      var gt = formatDate(data.generatedAt);
      if (gt) {
        genEl.textContent = '生成于 ' + gt;
        genEl.hidden = false;
      }
    }

    function announce(msg) {
      liveEl.textContent = msg;
    }

    /* ---- localStorage 记忆（节点位置 + 视口 + 折叠选择；失败降级为仅内存） ---- */
    var storeKey =
      'pi-cardex:layout:v2:' + encodeURIComponent(String(data.libraryId || 'default'));

    function storeGet() {
      try {
        var s = localStorage.getItem(storeKey);
        return s ? JSON.parse(s) : null;
      } catch (e) {
        return null;
      }
    }

    function storePut(obj) {
      try {
        localStorage.setItem(storeKey, JSON.stringify(obj));
      } catch (e) {
        /* 隐私模式等写入失败：布局仍在内存中可用 */
      }
    }

    function isFinitePoint(p) {
      return (
        !!p &&
        typeof p.x === 'number' &&
        typeof p.y === 'number' &&
        isFinite(p.x) &&
        isFinite(p.y)
      );
    }

    /* ---- 状态：选中 / 搜索 / 折叠 / 阅读方式 ---- */
    var selectedId = null;
    var detailReadingMode = 'batches'; /* 'batches' 按批阅读 | 'full' 完整原文；切换节点时重置 */
    var query = '';
    var searchState = null;
    var saved = storeGet();
    var userCollapsed = new Set();
    (Array.isArray(saved && saved.collapsed) ? saved.collapsed : []).forEach(function (id) {
      var kids = hierarchy.childrenOf.get(id);
      if (kids && kids.length) userCollapsed.add(id);
    });

    /* ---- 节点尺寸与层级布局 ---- */
    var nodeSizes = new Map();
    nodes.forEach(function (n) {
      var wrapped = wrapTitleText(n.title, LABEL_MAX_UNITS, 2);
      nodeSizes.set(n.id, {
        w: NODE_W,
        h: wrapped.lines.length * 17 + 22,
        lines: wrapped.lines,
      });
    });
    function sizeOf(id) {
      return nodeSizes.get(id) || { w: NODE_W, h: 40 };
    }

    var positions = new Map();
    var computedLayout = computeTreeLayout(
      hierarchy.roots,
      hierarchy.childrenOf,
      sizeOf,
      LAYOUT_OPTS
    );
    var savedPositions =
      saved && saved.positions && typeof saved.positions === 'object'
        ? saved.positions
        : null;
    nodes.forEach(function (n) {
      var sp = savedPositions ? savedPositions[n.id] : null;
      var p = isFinitePoint(sp) ? { x: sp.x, y: sp.y } : computedLayout.get(n.id);
      positions.set(n.id, { x: p.x, y: p.y });
    });

    /* ---- 画布：视图与节点 ---- */
    var view = { x: 0, y: 0, k: 1 };

    var nodeViews = new Map();
    nodes.forEach(function (n) {
      var lines = nodeSizes.get(n.id).lines;
      var h = nodeSizes.get(n.id).h;
      var g = svgMake('g', { class: 'node', 'data-id': n.id });
      var tip = svgMake('title');
      tip.textContent = n.title + (n.summary ? '\n' + n.summary : '');
      g.appendChild(tip);
      g.appendChild(
        svgMake('rect', {
          class: 'node-box',
          x: -NODE_W / 2,
          y: -h / 2,
          width: NODE_W,
          height: h,
          rx: 10,
        })
      );
      var text = svgMake('text', { class: 'node-label', 'text-anchor': 'middle' });
      lines.forEach(function (ln, idx) {
        var t = svgMake('tspan', {
          x: 0,
          y: (-(lines.length - 1) * 17) / 2 + idx * 17 + 4.5,
        });
        t.textContent = ln;
        text.appendChild(t);
      });
      g.appendChild(text);
      nodeLayer.appendChild(g);
      nodeViews.set(n.id, { g: g });
    });

    /* 父子连线：正交折线，父底部 → 子顶部 */
    var treeEdgeViews = [];
    var nodeTreeIdx = new Map();
    nodes.forEach(function (n) {
      nodeTreeIdx.set(n.id, []);
    });
    hierarchy.parentOf.forEach(function (pid, cid) {
      if (pid == null) return;
      var path = svgMake('path', { class: 'edge-tree', fill: 'none' });
      edgeLayer.appendChild(path);
      var ev = { parent: pid, child: cid, path: path };
      treeEdgeViews.push(ev);
      nodeTreeIdx.get(pid).push(ev);
      nodeTreeIdx.get(cid).push(ev);
    });

    /* 语义关联：虚线曲线，默认隐藏，仅在选中/悬停时出现 */
    var edgeViews = [];
    var nodeEdgeIdx = new Map();
    nodes.forEach(function (n) {
      nodeEdgeIdx.set(n.id, []);
    });
    edges.forEach(function (e) {
      var path = svgMake('path', { class: 'edge-semantic', fill: 'none' });
      var hit = svgMake('line', { class: 'edge-hit' });
      var label = svgMake('text', { class: 'edge-label' });
      label.textContent = e.relation || '关联';
      edgeLayer.appendChild(path);
      edgeLayer.appendChild(hit);
      labelLayer.appendChild(label);
      var ev = {
        source: e.source,
        target: e.target,
        relation: e.relation,
        reason: e.reason,
        path: path,
        hit: hit,
        label: label,
        hover: false,
      };
      edgeViews.push(ev);
      nodeEdgeIdx.get(e.source).push(ev);
      nodeEdgeIdx.get(e.target).push(ev);
      hit.addEventListener('pointerenter', function () {
        ev.hover = true;
        refreshAll();
      });
      hit.addEventListener('pointerleave', function () {
        ev.hover = false;
        refreshAll();
      });
    });

    function updateTreeEdgeGeom(ev) {
      var a = positions.get(ev.parent);
      var b = positions.get(ev.child);
      if (!a || !b) return;
      var ay = a.y + sizeOf(ev.parent).h / 2;
      var by = b.y - sizeOf(ev.child).h / 2;
      var midY = (ay + by) / 2;
      ev.path.setAttribute('d', 'M' + a.x + ' ' + ay + ' V' + midY + ' H' + b.x + ' V' + by);
    }

    function updateEdgeGeom(ev) {
      var a = positions.get(ev.source);
      var b = positions.get(ev.target);
      if (!a || !b) return;
      var dx = b.x - a.x;
      var dy = b.y - a.y;
      var cx = (a.x + b.x) / 2 - dy * 0.12;
      var cy = (a.y + b.y) / 2 + dx * 0.12;
      ev.path.setAttribute('d', 'M' + a.x + ' ' + a.y + ' Q' + cx + ' ' + cy + ' ' + b.x + ' ' + b.y);
      ev.hit.setAttribute('x1', a.x);
      ev.hit.setAttribute('y1', a.y);
      ev.hit.setAttribute('x2', b.x);
      ev.hit.setAttribute('y2', b.y);
      ev.label.setAttribute('x', (a.x + 2 * cx + b.x) / 4);
      ev.label.setAttribute('y', (a.y + 2 * cy + b.y) / 4 - 6);
    }

    function setNodePos(id, x, y) {
      var p = positions.get(id);
      if (!p) return;
      p.x = x;
      p.y = y;
      var v = nodeViews.get(id);
      v.g.setAttribute('transform', 'translate(' + x + ' ' + y + ')');
      nodeTreeIdx.get(id).forEach(updateTreeEdgeGeom);
      nodeEdgeIdx.get(id).forEach(updateEdgeGeom);
    }

    function applyPositionsAll() {
      positions.forEach(function (p, id) {
        setNodePos(id, p.x, p.y);
      });
    }

    /* ---- 视图变换 ---- */
    var saveTimer = 0;

    function round2(v) {
      return Math.round(v * 100) / 100;
    }

    function saveSoon() {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(function () {
        saveTimer = 0;
        var pos = {};
        positions.forEach(function (p, id) {
          pos[id] = { x: round2(p.x), y: round2(p.y) };
        });
        storePut({
          v: 2,
          positions: pos,
          viewport: { x: round2(view.x), y: round2(view.y), k: round2(view.k) },
          collapsed: Array.from(userCollapsed),
        });
      }, 400);
    }

    function applyView() {
      viewport.setAttribute(
        'transform',
        'translate(' + view.x + ' ' + view.y + ') scale(' + view.k + ')'
      );
      zoomInBtn.disabled = view.k >= K_MAX - 1e-9;
      zoomOutBtn.disabled = view.k <= K_MIN + 1e-9;
      saveSoon();
    }

    function toWorld(cx, cy) {
      var r = svg.getBoundingClientRect();
      return { x: (cx - r.left - view.x) / view.k, y: (cy - r.top - view.y) / view.k };
    }

    function zoomAt(cx, cy, factor) {
      var r = svg.getBoundingClientRect();
      var sx = cx - r.left;
      var sy = cy - r.top;
      var w = { x: (sx - view.x) / view.k, y: (sy - view.y) / view.k };
      view.k = clamp(view.k * factor, K_MIN, K_MAX);
      view.x = sx - w.x * view.k;
      view.y = sy - w.y * view.k;
      applyView();
    }

    function fitView() {
      var r = svg.getBoundingClientRect();
      if (!r.width || !r.height) return;
      var minX = Infinity;
      var minY = Infinity;
      var maxX = -Infinity;
      var maxY = -Infinity;
      positions.forEach(function (p, id) {
        var s = sizeOf(id);
        minX = Math.min(minX, p.x - s.w / 2);
        maxX = Math.max(maxX, p.x + s.w / 2);
        minY = Math.min(minY, p.y - s.h / 2);
        maxY = Math.max(maxY, p.y + s.h / 2);
      });
      var bw = Math.max(maxX - minX, 10);
      var bh = Math.max(maxY - minY, 10);
      var pad = 36;
      view.k = clamp(
        Math.min((r.width - pad * 2) / bw, (r.height - pad * 2) / bh),
        K_MIN,
        1.4
      );
      view.x = r.width / 2 - ((minX + maxX) / 2) * view.k;
      view.y = r.height / 2 - ((minY + maxY) / 2) * view.k;
      applyView();
    }

    function ensureNodeVisible(id) {
      var p = positions.get(id);
      if (!p) return;
      var r = svg.getBoundingClientRect();
      if (!r.width) return;
      var sx = p.x * view.k + view.x;
      var sy = p.y * view.k + view.y;
      var m = 100;
      var dx = 0;
      var dy = 0;
      if (sx < m) dx = m - sx;
      else if (sx > r.width - m) dx = r.width - m - sx;
      if (sy < m) dy = m - sy;
      else if (sy > r.height - m) dy = r.height - m - sy;
      if (dx || dy) {
        view.x += dx;
        view.y += dy;
        applyView();
      }
    }

    /* ---- 匹配与搜索 ---- */
    function matchNode(q, node) {
      if (!q) return true;
      return (
        node.title.toLowerCase().indexOf(q) >= 0 ||
        node.summary.toLowerCase().indexOf(q) >= 0
      );
    }

    function applyQuery(value) {
      query = String(value || '').trim().toLowerCase();
      searchState = query
        ? treeQuery(allIds, hierarchy.parentOf, function (id) {
            return matchNode(query, nodeById.get(id));
          })
        : null;
      refreshTree();
      refreshAll();
      updateListTabindex();
    }

    /* ---- 知识树（左栏） ---- */
    var treeOrder = [];
    var treeRows = new Map();

    function buildTreeDom() {
      function buildLevel(parentId, ul) {
        var kids = parentId == null ? hierarchy.roots : hierarchy.childrenOf.get(parentId) || [];
        kids.forEach(function (id) {
          var node = nodeById.get(id);
          var kidsOf = hierarchy.childrenOf.get(id) || [];
          var hasKids = kidsOf.length > 0;
          var li = document.createElement('li');
          li.className = 'tree-item';
          li.setAttribute('role', 'treeitem');
          li.setAttribute('data-id', id);
          var row = document.createElement('div');
          row.className = 'tree-row';
          var head;
          if (hasKids) {
            head = document.createElement('button');
            head.type = 'button';
            head.className = 'tree-toggle';
            head.tabIndex = -1;
            head.setAttribute('aria-expanded', 'true');
            var lbl = document.createElement('span');
            lbl.className = 'sr-only';
            lbl.textContent = '展开或收起 ' + node.title;
            head.appendChild(lbl);
            head.addEventListener('click', function () {
              toggleCollapse(id);
            });
          } else {
            head = document.createElement('span');
            head.className = 'tree-spacer';
          }
          row.appendChild(head);
          if (node.kind === 'group') {
            var chip = document.createElement('span');
            chip.className = 'tree-chip';
            chip.textContent = '分组';
            row.appendChild(chip);
          }
          var title = document.createElement('button');
          title.type = 'button';
          title.className = 'tree-title';
          title.tabIndex = -1;
          title.addEventListener('click', function () {
            selectNode(id);
          });
          row.appendChild(title);
          li.appendChild(row);
          ul.appendChild(li);
          var rec = {
            id: id,
            node: node,
            li: li,
            row: row,
            toggle: hasKids ? head : null,
            titleBtn: title,
            hasKids: hasKids,
          };
          treeRows.set(id, rec);
          treeOrder.push(rec);
          if (hasKids) {
            var sub = document.createElement('ul');
            sub.className = 'tree-group';
            sub.setAttribute('role', 'group');
            li.appendChild(sub);
            buildLevel(id, sub);
          }
        });
      }
      buildLevel(null, treeEl);
    }

    function appendMarked(el, text, q) {
      if (!q) {
        el.appendChild(document.createTextNode(text));
        return;
      }
      var idx = text.toLowerCase().indexOf(q);
      if (idx < 0) {
        el.appendChild(document.createTextNode(text));
        return;
      }
      el.appendChild(document.createTextNode(text.slice(0, idx)));
      var mk = document.createElement('mark');
      mk.textContent = text.slice(idx, idx + q.length);
      el.appendChild(mk);
      el.appendChild(document.createTextNode(text.slice(idx + q.length)));
    }

    function renderRowContent(rec, q) {
      var btn = rec.titleBtn;
      while (btn.firstChild) btn.removeChild(btn.firstChild);
      appendMarked(btn, rec.node.title, q);
      if (q && searchState && searchState.hitIds.has(rec.id) && rec.node.summary) {
        var s = document.createElement('span');
        s.className = 'tree-summary';
        appendMarked(s, rec.node.summary, q);
        btn.appendChild(s);
      }
    }

    function refreshTree() {
      var visible = new Set();
      var expanded = new Set();
      function walk(id) {
        visible.add(id);
        var kids = hierarchy.childrenOf.get(id) || [];
        if (!kids.length) return;
        var isOpen = query ? searchState.expand.has(id) : !userCollapsed.has(id);
        if (isOpen) {
          expanded.add(id);
          for (var i = 0; i < kids.length; i++) {
            var k = kids[i];
            if (!query || searchState.visible.has(k)) walk(k);
          }
        }
      }
      for (var r = 0; r < hierarchy.roots.length; r++) {
        var rid = hierarchy.roots[r];
        if (!query || searchState.visible.has(rid)) walk(rid);
      }

      treeOrder.forEach(function (rec) {
        rec.li.hidden = !visible.has(rec.id);
        var cur = rec.id === selectedId;
        rec.row.classList.toggle('selected', cur);
        if (cur) {
          rec.li.setAttribute('aria-selected', 'true');
          rec.titleBtn.setAttribute('aria-current', 'true');
        } else {
          rec.li.removeAttribute('aria-selected');
          rec.titleBtn.removeAttribute('aria-current');
        }
        if (rec.hasKids) {
          var isOpen = expanded.has(rec.id);
          rec.li.setAttribute('aria-expanded', String(isOpen));
          if (rec.toggle) {
            rec.toggle.setAttribute('aria-expanded', String(isOpen));
            rec.toggle.disabled = !!query;
          }
        }
        renderRowContent(rec, query);
      });

      listCount.textContent = query
        ? searchState.hitIds.size + ' / ' + nodes.length
        : String(nodes.length);
      var noHits = !!query && !searchState.hitIds.size;
      listEmpty.hidden = !noHits;
      if (noHits) listEmpty.textContent = '没有匹配「' + query + '」的知识点';
    }

    function visibleTreeRows() {
      return treeOrder.filter(function (rec) {
        return !rec.li.hidden;
      });
    }

    function isRowExpanded(rec) {
      return query ? searchState.expand.has(rec.id) : !userCollapsed.has(rec.id);
    }

    function setCollapsed(id, collapsed) {
      if (query) return;
      if (collapsed) userCollapsed.add(id);
      else userCollapsed.delete(id);
      refreshTree();
      updateListTabindex();
      saveSoon();
      announce((collapsed ? '已收起 ' : '已展开 ') + nodeById.get(id).title);
      if (collapsed) {
        var ae = document.activeElement;
        var li = ae && ae.closest ? ae.closest('.tree-item') : null;
        if (li && li.hidden) {
          var rec = treeRows.get(id);
          if (rec) rec.titleBtn.focus();
        }
      }
    }

    function toggleCollapse(id) {
      if (query) return;
      setCollapsed(id, !userCollapsed.has(id));
    }

    function updateListTabindex() {
      var focusIdx = -1;
      treeOrder.forEach(function (rec, idx) {
        if (rec.li.hidden) return;
        if (focusIdx < 0) focusIdx = idx;
        if (selectedId && rec.id === selectedId) focusIdx = idx;
      });
      treeOrder.forEach(function (rec, idx) {
        rec.titleBtn.tabIndex = idx === focusIdx ? 0 : -1;
      });
    }

    function updateListSelection() {
      var active = selectedId ? treeRows.get(selectedId) : null;
      if (active && !active.li.hidden && listScroll.scrollHeight > listScroll.clientHeight + 4) {
        var r = active.li.getBoundingClientRect();
        var cr = listScroll.getBoundingClientRect();
        if (r.top < cr.top) listScroll.scrollTop -= cr.top - r.top - 4;
        else if (r.bottom > cr.bottom) listScroll.scrollTop += r.bottom - cr.bottom + 4;
      }
      updateListTabindex();
    }

    treeEl.addEventListener('keydown', function (e) {
      var li = e.target && e.target.closest ? e.target.closest('.tree-item') : null;
      if (!li) return;
      var id = li.getAttribute('data-id');
      var rec = treeRows.get(id);
      if (!rec) return;
      var vis = visibleTreeRows();
      var idx = -1;
      for (var i = 0; i < vis.length; i++) {
        if (vis[i] === rec) {
          idx = i;
          break;
        }
      }

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        var next = idx < 0 ? 0 : clamp(idx + (e.key === 'ArrowDown' ? 1 : -1), 0, vis.length - 1);
        var target = vis[next];
        if (target) {
          target.titleBtn.focus();
          selectNode(target.id);
        }
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault();
        var t2 = vis[e.key === 'Home' ? 0 : vis.length - 1];
        if (t2) {
          t2.titleBtn.focus();
          selectNode(t2.id);
        }
      } else if (e.key === 'ArrowRight') {
        if (!rec.hasKids) return;
        e.preventDefault();
        if (isRowExpanded(rec)) {
          var kids = vis.filter(function (r2) {
            return hierarchy.parentOf.get(r2.id) === id;
          });
          if (kids.length) kids[0].titleBtn.focus();
        } else {
          setCollapsed(id, false);
        }
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (rec.hasKids && isRowExpanded(rec)) {
          setCollapsed(id, true);
        } else {
          var pid = hierarchy.parentOf.get(id);
          var pRec = pid != null ? treeRows.get(pid) : null;
          if (pRec && !pRec.li.hidden) pRec.titleBtn.focus();
        }
      }
    });

    searchInput.addEventListener('input', function () {
      applyQuery(searchInput.value);
    });
    searchInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        var first = null;
        var vis = visibleTreeRows();
        var hit = null;
        for (var i = 0; i < vis.length; i++) {
          if (!query || (searchState && searchState.hitIds.has(vis[i].id))) {
            hit = vis[i];
            break;
          }
        }
        first = hit || vis[0];
        if (first) {
          selectNode(first.id);
          first.titleBtn.focus();
        }
      }
    });

    document.addEventListener('keydown', function (e) {
      var t = e.target;
      var typing =
        t &&
        (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (e.key === '/' && !typing) {
        e.preventDefault();
        searchInput.focus();
        searchInput.select();
      } else if (e.key === 'Escape') {
        if (typing && t === searchInput && searchInput.value) {
          searchInput.value = '';
          applyQuery('');
        } else if (selectedId) {
          selectNode(null);
        }
      }
    });

    /* ---- 图谱状态刷新 ---- */
    function refreshAll() {
      var visibleSet = searchState ? searchState.visible : null;
      nodeViews.forEach(function (v, id) {
        var node = nodeById.get(id);
        var cls =
          'node node-kind-' + node.kind + ' node-depth-' + (hierarchy.depthOf.get(id) || 0);
        var related = false;
        if (selectedId) {
          if (id === selectedId) cls += ' node-selected';
          else if (adjacency.get(selectedId) && adjacency.get(selectedId).has(id)) {
            cls += ' node-related';
            related = true;
          }
        }
        if (query && !related && id !== selectedId && visibleSet && !visibleSet.has(id)) {
          cls += ' node-dim';
        }
        v.g.setAttribute('class', cls);
      });
      treeEdgeViews.forEach(function (ev) {
        var cls = 'edge-tree';
        if (selectedId && (ev.parent === selectedId || ev.child === selectedId)) {
          cls += ' edge-tree-active';
        }
        if (visibleSet && !visibleSet.has(ev.parent) && !visibleSet.has(ev.child)) {
          cls += ' edge-dim';
        }
        ev.path.setAttribute('class', cls);
      });
      edgeViews.forEach(function (ev) {
        var connected = selectedId && (ev.source === selectedId || ev.target === selectedId);
        var shown = !!connected || !!ev.hover;
        var cls = 'edge-semantic';
        if (ev.hover) cls += ' edge-hover';
        if (shown) cls += ' show';
        ev.path.setAttribute('class', cls);
        ev.hit.setAttribute('class', shown ? 'edge-hit show' : 'edge-hit');
        ev.label.classList.toggle('show', shown);
      });
    }

    /* ---- 详情面板 ---- */
    function downloadNode(node) {
      var text = node.markdown != null ? String(node.markdown) : '';
      var name = '';
      if (node.file) name = String(node.file).split('/').pop() || '';
      if (!name) {
        name = node.title.replace(/[\\/:*?"<>|\r\n]+/g, '_').trim() || 'card';
      }
      if (!/\.md$/i.test(name)) name += '.md';
      try {
        var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () {
          URL.revokeObjectURL(url);
        }, 5000);
        announce('已下载 ' + name);
      } catch (err) {
        announce('下载失败：' + (err && err.message ? err.message : '未知错误'));
      }
    }

    function sectionTitle(text) {
      var h = document.createElement('h3');
      h.textContent = text;
      return h;
    }

    function kindChip(kind) {
      var chip = document.createElement('span');
      chip.className = 'child-chip kind-' + kind;
      chip.textContent = kind === 'group' ? '分组' : '知识';
      return chip;
    }

    function renderCrumbs(node) {
      var chain = [];
      var p = hierarchy.parentOf.get(node.id) || null;
      var guard = 0;
      while (p != null && guard++ < MAX_TREE_DEPTH) {
        chain.push(p);
        p = hierarchy.parentOf.get(p) || null;
      }
      if (!chain.length) return null;
      chain.reverse();
      var nav = document.createElement('nav');
      nav.className = 'crumbs';
      nav.setAttribute('aria-label', '上级路径');
      chain.forEach(function (pid, i) {
        if (i) {
          var sep = document.createElement('span');
          sep.className = 'crumb-sep';
          sep.textContent = '›';
          nav.appendChild(sep);
        }
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'crumb-btn';
        b.title = nodeById.get(pid).title;
        b.textContent = nodeById.get(pid).title;
        b.addEventListener('click', function () {
          selectNode(pid);
        });
        nav.appendChild(b);
      });
      return nav;
    }

    function renderChildSection(node) {
      var kids = hierarchy.childrenOf.get(node.id) || [];
      if (!kids.length) return null;
      var sec = document.createElement('section');
      sec.className = 'detail-section';
      sec.appendChild(sectionTitle('子知识点（' + kids.length + '）'));
      var ul = document.createElement('ul');
      ul.className = 'child-list';
      kids.forEach(function (cid) {
        var child = nodeById.get(cid);
        var li = document.createElement('li');
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'child-item';
        btn.addEventListener('click', function () {
          selectNode(cid);
        });
        btn.appendChild(kindChip(child.kind));
        var nameEl = document.createElement('span');
        nameEl.className = 'child-title';
        nameEl.textContent = child.title;
        btn.appendChild(nameEl);
        var grand = hierarchy.childrenOf.get(cid) || [];
        if (child.kind === 'group' && grand.length) {
          var cnt = document.createElement('span');
          cnt.className = 'child-count';
          cnt.textContent = grand.length + ' 项';
          btn.appendChild(cnt);
        }
        li.appendChild(btn);
        ul.appendChild(li);
      });
      sec.appendChild(ul);
      return sec;
    }

    function renderRelatedSection(node) {
      var sec = document.createElement('section');
      sec.className = 'detail-section';
      var relEdges = edges
        .filter(function (e) {
          return e.source === node.id || e.target === node.id;
        })
        .sort(function (a, b) {
          var ta = nodeById.get(a.source === node.id ? a.target : a.source).title;
          var tb = nodeById.get(b.source === node.id ? b.target : b.source).title;
          return ta.localeCompare(tb, 'zh-Hans-CN');
        });
      sec.appendChild(
        sectionTitle(relEdges.length ? '相关知识（' + relEdges.length + '）' : '相关知识')
      );
      if (relEdges.length) {
        var ul = document.createElement('ul');
        ul.className = 'rel-list';
        relEdges.forEach(function (e) {
          var otherId = e.source === node.id ? e.target : e.source;
          var other = nodeById.get(otherId);
          var li = document.createElement('li');
          var btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'rel-item';
          btn.addEventListener('click', function () {
            selectNode(otherId);
          });
          var chipRel = document.createElement('span');
          chipRel.className = 'rel-chip';
          chipRel.textContent = e.relation || '关联';
          var nameEl = document.createElement('span');
          nameEl.className = 'rel-title';
          nameEl.textContent = other.title;
          btn.appendChild(chipRel);
          btn.appendChild(nameEl);
          if (e.reason) {
            var reasonEl = document.createElement('span');
            reasonEl.className = 'rel-reason';
            reasonEl.textContent = e.reason;
            btn.appendChild(reasonEl);
          }
          li.appendChild(btn);
          ul.appendChild(li);
        });
        sec.appendChild(ul);
      } else {
        var none = document.createElement('p');
        none.className = 'rel-none';
        none.textContent = '还没有通过语义关联连接的其他节点。';
        sec.appendChild(none);
      }
      return sec;
    }

    /* ---- 分批阅读：模式切换 / 补充记录导航 / 批次正文 / 原文折叠 ---- */

    function renderModeToggle() {
      var wrap = div('mode-toggle');
      wrap.setAttribute('role', 'group');
      wrap.setAttribute('aria-label', '阅读方式');
      ['batches', 'full'].forEach(function (mode) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'mode-btn' + (detailReadingMode === mode ? ' is-active' : '');
        b.setAttribute('aria-pressed', detailReadingMode === mode ? 'true' : 'false');
        b.textContent = mode === 'batches' ? '分次阅读' : '完整 Markdown';
        b.addEventListener('click', function () {
          switchReadingMode(mode);
        });
        wrap.appendChild(b);
      });
      return wrap;
    }

    function switchReadingMode(mode) {
      if (mode !== 'batches' && mode !== 'full') return;
      if (detailReadingMode === mode) return;
      detailReadingMode = mode;
      renderDetail();
      /* 重渲染后焦点回到激活的模式按钮，避免键盘焦点丢失到 body */
      var active = detailEl.querySelector('.mode-btn.is-active');
      if (detailScroll) detailScroll.scrollTop = 0;
      if (window.matchMedia('(max-width: 1079.98px)').matches) {
        requestAnimationFrame(function () {
          var topbar = document.querySelector('.topbar');
          var h = topbar ? topbar.getBoundingClientRect().height : 0;
          var top = window.scrollY + detailEl.getBoundingClientRect().top - h;
          window.scrollTo(0, Math.max(0, top));
        });
      }
      if (active) {
        active.focus({ preventScroll: true });
      }
      announce(mode === 'batches' ? '已切换到分次阅读' : '已切换到完整 Markdown');
    }

    /** 补充记录导航：≥2 批才显示；每项「第 N 批 · 日期 · 标题（截断）」，另附最新补充直达。 */
    function renderRecordNav(node) {
      var records = node.reading.records;
      if (records.length < 2) return null;
      var nav = document.createElement('nav');
      nav.className = 'record-nav';
      nav.setAttribute('aria-label', '补充记录');
      var index = document.createElement('details');
      index.className = 'record-index';
      var label = document.createElement('summary');
      label.className = 'record-nav-label';
      label.textContent = '归档记录 · ' + records.length + ' 次';
      index.appendChild(label);
      var list = document.createElement('ul');
      list.className = 'record-nav-list';
      records.forEach(function (r, i) {
        var li = document.createElement('li');
        li.appendChild(recordNavBtn(r, i + 1));
        list.appendChild(li);
      });
      index.appendChild(list);
      nav.appendChild(index);
      var latest = recordNavBtn(records[records.length - 1], records.length);
      latest.classList.add('record-nav-latest');
      latest.textContent = '最近补充 ↓';
      latest.title = truncateTitles(records[records.length - 1].titles, 100);
      nav.appendChild(latest);
      return nav;
    }

    function recordNavBtn(record, n) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'record-nav-item';
      var when = document.createElement('span');
      when.className = 'record-nav-when';
      when.textContent = '第 ' + n + ' 次 · ' + (formatDate(record.archivedAt, true) || '日期未知');
      var what = document.createElement('span');
      what.className = 'record-nav-what';
      what.textContent = truncateTitles(record.titles, 34);
      btn.appendChild(when);
      btn.appendChild(what);
      btn.addEventListener('click', function () {
        revealRecord(n);
      });
      return btn;
    }

    /** 标题列表截断：多标题用「；」连接，超长加省略号；无标题时退回占位文案。 */
    function truncateTitles(titles, max) {
      var s = (titles || []).filter(Boolean).join('；');
      if (!s) return '本批整理';
      s = s.replace(/\s+/g, ' ').trim();
      return s.length > max ? s.slice(0, Math.max(1, max - 1)) + '…' : s;
    }

    /** 批次正文：前言 → 各批（日期/整理者 + 整理正文 + 折叠原始问答）。 */
    function renderBatchBody(node) {
      var views = buildReadingViews(node);
      var root = document.createElement('div');
      root.className = 'reading-body';
      views.docs.forEach(function (doc) {
        var ctx = { anchors: doc.anchorMap, globalAnchors: views.anchorMap };
        if (doc.kind === 'intro') {
          root.appendChild(renderBlocks(doc.blocks, ctx));
          return;
        }
        if (doc.kind === 'content') {
          var i = doc.index;
          var article = document.createElement('article');
          article.className = 'record-article';
          article.id = 'record-' + (i + 1);
          article.setAttribute('data-record', String(i + 1));
          article.setAttribute('tabindex', '-1');
          var hd = document.createElement('header');
          hd.className = 'record-head';
          var badge = document.createElement('span');
          badge.className = 'record-badge';
          badge.textContent = i === 0 ? '首次整理' : '第 ' + (i + 1) + ' 次归档';
          var meta = document.createElement('span');
          meta.className = 'record-meta';
          var bits = [];
          var d = formatDate(doc.record.archivedAt, true);
          if (d) bits.push(d);
          if (doc.record.organizer) bits.push('整理：' + doc.record.organizer);
          meta.textContent = bits.join(' · ');
          hd.appendChild(badge);
          hd.appendChild(meta);
          article.appendChild(hd);
          article.appendChild(renderBlocks(doc.blocks, ctx));
          root.appendChild(article);
          return;
        }
        if (doc.kind === 'transcript') {
          var host = root.querySelector('.record-article[data-record="' + (doc.index + 1) + '"]');
          if (!host) return;
          var details = document.createElement('details');
          details.className = 'transcript';
          var summary = document.createElement('summary');
          summary.appendChild(document.createTextNode('原始问答'));
          details.appendChild(summary);
          details.appendChild(renderBlocks(doc.blocks, ctx));
          host.appendChild(details);
        }
      });
      return root;
    }

    /** 跳到指定批次：桌面滚 .detail-scroll，窄屏滚 body（避开 sticky 顶栏），并给目标一次高亮。 */
    function revealRecord(n) {
      var el = detailEl.querySelector('.record-article[data-record="' + n + '"]');
      if (!el) return;
      var GAP = 8;
      if (!window.matchMedia('(max-width: 1079.98px)').matches && detailScroll) {
        detailScroll.scrollTop =
          detailScroll.scrollTop + el.getBoundingClientRect().top - detailScroll.getBoundingClientRect().top - GAP;
      } else {
        var topbar = document.querySelector('.topbar');
        var h = topbar ? topbar.getBoundingClientRect().height : 0;
        window.scrollTo(0, Math.max(0, window.scrollY + el.getBoundingClientRect().top - h - GAP));
      }
      el.classList.remove('is-flash');
      void el.offsetWidth; /* 重置动画 */
      el.classList.add('is-flash');
      setTimeout(function () {
        el.classList.remove('is-flash');
      }, 1400);
      el.focus({ preventScroll: true });
      announce('已跳到第 ' + n + ' 次归档');
    }

    function renderDetail() {
      while (detailEl.firstChild) detailEl.removeChild(detailEl.firstChild);
      var node = selectedId ? nodeById.get(selectedId) : null;
      if (!node) {
        var hint = div('detail-empty');
        hint.textContent =
          '在知识树或图谱中选择一个节点，这里会显示分组结构、Markdown 卡片和关联。';
        detailEl.appendChild(hint);
        return;
      }

      var isGroup = node.kind === 'group';

      /* 头部 */
      var head = div('detail-head');
      var kicker = div('detail-kicker');
      kicker.appendChild(document.createTextNode(isGroup ? '分组' : '知识卡片'));
      if (isGroup) {
        var kids = hierarchy.childrenOf.get(node.id) || [];
        if (kids.length) {
          var gchip = document.createElement('span');
          gchip.className = 'detail-chip';
          gchip.textContent = kids.length + ' 个子节点';
          kicker.appendChild(gchip);
        }
      } else if (node.entryCount > 0) {
        var chip = document.createElement('span');
        chip.className = 'detail-chip';
        chip.textContent = node.entryCount + ' 条记录';
        kicker.appendChild(chip);
      }
      head.appendChild(kicker);
      var title = document.createElement('h2');
      title.className = 'detail-title';
      title.textContent = node.title;
      head.appendChild(title);
      if (node.summary) {
        var sum = document.createElement('p');
        sum.className = 'detail-summary';
        sum.textContent = node.summary;
        head.appendChild(sum);
      }
      var crumbs = renderCrumbs(node);
      if (crumbs) head.appendChild(crumbs);
      var meta = div('detail-meta');
      if (node.updatedAt) {
        var up = document.createElement('span');
        up.textContent = '更新于 ' + formatDate(node.updatedAt);
        meta.appendChild(up);
      }
      if (!isGroup && node.file) {
        var fh = safeHref(node.file);
        if (fh) {
          var fl = document.createElement('a');
          fl.className = 'file-link';
          fl.href = fh.href;
          fl.title = '相对于本页的卡片文件';
          fl.textContent = node.file;
          meta.appendChild(fl);
        } else {
          var fs = document.createElement('span');
          fs.textContent = node.file;
          meta.appendChild(fs);
        }
      }
      head.appendChild(meta);
      if (!isGroup && node.markdown) {
        var actions = div('detail-actions');
        if (node.reading) actions.appendChild(renderModeToggle());
        var dl = document.createElement('button');
        dl.type = 'button';
        dl.className = 'button-primary';
        dl.textContent = '下载 Markdown';
        dl.addEventListener('click', function () {
          downloadNode(node);
        });
        actions.appendChild(dl);
        head.appendChild(actions);
      }
      detailEl.appendChild(head);

      /* 正文先于关系列表（阅读优先，导航仍保留在后） */
      if (!isGroup && node.reading && detailReadingMode !== 'full') {
        var nav = renderRecordNav(node);
        if (nav) detailEl.appendChild(nav);
        var batchSection = document.createElement('section');
        batchSection.className = 'detail-section';
        batchSection.appendChild(sectionTitle('卡片正文'));
        var batchBody = renderBatchBody(node);
        if (!batchBody.childElementCount) {
          var bEmpty = document.createElement('p');
          bEmpty.className = 'md-empty';
          bEmpty.textContent = '（卡片没有正文内容）';
          batchBody.appendChild(bEmpty);
        }
        batchSection.appendChild(batchBody);
        detailEl.appendChild(batchSection);
      } else if (!isGroup) {
        var cardSection = document.createElement('section');
        cardSection.className = 'detail-section';
        cardSection.appendChild(sectionTitle('卡片正文'));
        if (!node.reading && node.entryCount > 1) {
          var mergeNote = document.createElement('p');
          mergeNote.className = 'merge-note';
          mergeNote.textContent =
            '这张卡片由 ' + node.entryCount + ' 次讨论累积而成，暂未能按批拆分，以下为完整原文。';
          cardSection.appendChild(mergeNote);
        }
        var mdRoot = renderMarkdown(node.markdown, { skipTitle: node.title });
        if (!mdRoot.childElementCount) {
          var empty = document.createElement('p');
          empty.className = 'md-empty';
          empty.textContent = '（卡片没有正文内容）';
          mdRoot.appendChild(empty);
        }
        cardSection.appendChild(mdRoot);
        detailEl.appendChild(cardSection);
      }

      /* 子知识点 */
      var childSec = renderChildSection(node);
      if (childSec) detailEl.appendChild(childSec);

      /* 相关知识（语义关联） */
      detailEl.appendChild(renderRelatedSection(node));
    }

    /* ---- 选中（同步树展开与图谱视图） ---- */
    function selectNode(id, opts) {
      opts = opts || {};
      selectedId = id;
      detailReadingMode = 'batches'; /* 切换节点不保留上一张卡的阅读方式与展开状态 */
      if (id != null) {
        var p = hierarchy.parentOf.get(id) || null;
        var guard = 0;
        while (p != null && guard++ < MAX_TREE_DEPTH) {
          userCollapsed.delete(p);
          p = hierarchy.parentOf.get(p) || null;
        }
      }
      refreshTree();
      refreshAll();
      updateListSelection();
      renderDetail();
      if (id) {
        if (detailScroll) detailScroll.scrollTop = 0;
        if (window.matchMedia('(max-width: 1079.98px)').matches) {
          requestAnimationFrame(function () {
            var topbar = document.querySelector('.topbar');
            var top =
              window.scrollY + detailEl.getBoundingClientRect().top - topbar.getBoundingClientRect().height;
            window.scrollTo(0, Math.max(0, top));
          });
        }
        announce('已选择：' + nodeById.get(id).title);
        if (!opts.keepView) ensureNodeVisible(id);
      } else {
        announce('已取消选择');
      }
    }

    /* ---- 画布指针交互：拖节点 / 平移 / 双指捏合 ---- */
    var pointers = new Map();
    var gesture = null;

    function pointerEntries() {
      var arr = [];
      pointers.forEach(function (p) {
        arr.push(p);
      });
      return arr;
    }

    function startPinch() {
      var pts = pointerEntries();
      if (pts.length < 2) return;
      var a = pts[0];
      var b = pts[1];
      gesture = {
        type: 'pinch',
        startDist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        startMid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        startView: { x: view.x, y: view.y, k: view.k },
      };
    }

    function updatePinch() {
      var pts = pointerEntries();
      if (pts.length < 2 || !gesture) return;
      var a = pts[0];
      var b = pts[1];
      var rect = svg.getBoundingClientRect();
      var d = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      var mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      var k0 = gesture.startView.k;
      var k = clamp(k0 * (d / gesture.startDist), K_MIN, K_MAX);
      var wx = (gesture.startMid.x - rect.left - gesture.startView.x) / k0;
      var wy = (gesture.startMid.y - rect.top - gesture.startView.y) / k0;
      view.k = k;
      view.x = mid.x - rect.left - wx * k;
      view.y = mid.y - rect.top - wy * k;
      applyView();
    }

    svg.addEventListener('pointerdown', function (e) {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try {
        svg.setPointerCapture(e.pointerId);
      } catch (err) {
        /* 捕获失败时事件仍可冒泡处理 */
      }
      if (pointers.size === 2) {
        startPinch();
        return;
      }
      if (pointers.size > 2) return;
      var nodeG = e.target && e.target.closest ? e.target.closest('.node') : null;
      if (nodeG) {
        var id = nodeG.getAttribute('data-id');
        gesture = {
          type: 'node',
          id: id,
          moved: false,
          startClient: { x: e.clientX, y: e.clientY },
          orig: {
            x: positions.get(id).x,
            y: positions.get(id).y,
          },
          startWorld: toWorld(e.clientX, e.clientY),
        };
      } else {
        gesture = {
          type: 'pan',
          moved: false,
          startClient: { x: e.clientX, y: e.clientY },
          origView: { x: view.x, y: view.y },
        };
        svg.classList.add('panning');
      }
    });

    svg.addEventListener('pointermove', function (e) {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (!gesture) return;
      if (gesture.type === 'pinch') {
        updatePinch();
        return;
      }
      var dx = e.clientX - gesture.startClient.x;
      var dy = e.clientY - gesture.startClient.y;
      if (!gesture.moved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
        gesture.moved = true;
      }
      if (!gesture.moved) return;
      if (gesture.type === 'pan') {
        view.x = gesture.origView.x + dx;
        view.y = gesture.origView.y + dy;
        applyView();
      } else if (gesture.type === 'node') {
        var w = toWorld(e.clientX, e.clientY);
        var nx = clamp(gesture.orig.x + (w.x - gesture.startWorld.x), -8000, 8000);
        var ny = clamp(gesture.orig.y + (w.y - gesture.startWorld.y), -8000, 8000);
        setNodePos(gesture.id, nx, ny);
        svg.classList.add('node-dragging');
      }
    });

    function endPointer(e, cancelled) {
      if (!pointers.has(e.pointerId)) return;
      pointers.delete(e.pointerId);
      if (gesture && gesture.type === 'pinch') {
        if (pointers.size === 1) {
          var rest = pointerEntries()[0];
          gesture = {
            type: 'pan',
            moved: true,
            startClient: { x: rest.x, y: rest.y },
            origView: { x: view.x, y: view.y },
          };
        } else if (!pointers.size) {
          gesture = null;
          saveSoon();
        }
        return;
      }
      var g = gesture;
      gesture = null;
      svg.classList.remove('panning', 'node-dragging');
      if (!g || cancelled) return;
      if (g.type === 'node') {
        if (g.moved) saveSoon();
        else selectNode(g.id);
      } else if (g.type === 'pan') {
        if (g.moved) saveSoon();
        else selectNode(null);
      }
    }

    svg.addEventListener('pointerup', function (e) {
      endPointer(e, false);
    });
    svg.addEventListener('pointercancel', function (e) {
      endPointer(e, true);
    });

    svg.addEventListener(
      'wheel',
      function (e) {
        e.preventDefault();
        var dy = e.deltaY;
        if (e.deltaMode === 1) dy *= 16;
        else if (e.deltaMode === 2) dy *= 100;
        zoomAt(e.clientX, e.clientY, Math.exp(-dy * 0.0016));
      },
      { passive: false }
    );

    svg.addEventListener('dblclick', function (e) {
      if (e.target && e.target.closest && e.target.closest('.node')) return;
      zoomAt(e.clientX, e.clientY, 1.55);
    });

    /* ---- 工具按钮 ---- */
    zoomInBtn.addEventListener('click', function () {
      var r = svg.getBoundingClientRect();
      zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.35);
    });
    zoomOutBtn.addEventListener('click', function () {
      var r = svg.getBoundingClientRect();
      zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.35);
    });
    fitBtn.addEventListener('click', function () {
      fitView();
      announce('已适配视图');
    });
    relayoutBtn.addEventListener('click', function () {
      positions = computeTreeLayout(hierarchy.roots, hierarchy.childrenOf, sizeOf, LAYOUT_OPTS);
      applyPositionsAll();
      fitView();
      saveSoon();
      announce('已重新排布节点');
    });

    graphToggle.addEventListener('click', function () {
      var collapsed = graphPane.classList.toggle('collapsed');
      graphToggle.setAttribute('aria-expanded', String(!collapsed));
      graphToggle.textContent = collapsed ? '展开图谱' : '收起图谱';
    });

    window.addEventListener('resize', function () {
      applyView();
    });

    /* ---- 初始化呈现 ---- */
    buildTreeDom();
    applyPositionsAll();
    applyQuery('');
    renderDetail();

    var sv = saved && saved.viewport;
    if (sv && isFinite(sv.x) && isFinite(sv.y) && isFinite(sv.k) && sv.k > 0) {
      view = { x: sv.x, y: sv.y, k: clamp(sv.k, K_MIN, K_MAX) };
      applyView();
    } else {
      fitView();
    }
    refreshAll();
    updateListSelection();
  }

  function showFatal(msg) {
    document.body.classList.add('is-empty');
    var layoutEl = document.getElementById('layout');
    if (layoutEl) layoutEl.hidden = true;
    var fatalEl = document.getElementById('fatal');
    var msgEl = document.getElementById('fatal-msg');
    if (msgEl) msgEl.textContent = msg;
    if (fatalEl) fatalEl.hidden = false;
  }

  function boot() {
    try {
      init();
    } catch (err) {
      showFatal('页面初始化失败：' + (err && err.message ? err.message : '未知错误'));
    }
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  }

  /* Node 环境导出，供离线纯函数测试使用。 */
  if (typeof module !== 'undefined' && module && module.exports !== undefined) {
    module.exports = {
      mdParse: mdParse,
      scanInline: scanInline,
      safeHref: safeHref,
      slugify: slugify,
      wrapTitleText: wrapTitleText,
      buildHierarchy: buildHierarchy,
      treeQuery: treeQuery,
      computeTreeLayout: computeTreeLayout,
      decodeEntities: decodeEntities,
      textOfTokens: textOfTokens,
      inlinePlain: inlinePlain,
      formatDate: formatDate,
      applySkipTitle: applySkipTitle,
      prepareHeadingIds: prepareHeadingIds,
      resolveAnchor: resolveAnchor,
      normalizeReading: normalizeReading,
      buildReadingViews: buildReadingViews,
    };
  }
})();
