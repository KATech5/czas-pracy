/*
 * Minimalny generator PDF dla eSPe Time Tracker. Bez bibliotek zewnętrznych.
 * - osadza czcionkę TrueType (Carlito) jako Type0/Identity-H, więc polskie znaki działają
 * - kompresuje strumienie przez CompressionStream('deflate') (Chrome/Android)
 * - przyjmuje gotowy "model raportu" przygotowany przez aplikację (same teksty)
 *
 * window.EspePdf.load()        -> pobiera czcionki i logo (wywołaj wcześniej, żeby PDF powstał szybko)
 * window.EspePdf.build(model)  -> Promise<Blob> z plikiem PDF
 */
(function () {
  'use strict';
  var W = 210, H = 297, K = 72 / 25.4; // strona A4 w mm, mm -> pt

  /* ---------- parser TrueType ---------- */
  function parseTTF(buf) {
    var dv = new DataView(buf), tb = {}, n = dv.getUint16(4), i;
    for (i = 0; i < n; i++) {
      var o = 12 + i * 16;
      var tag = String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
      tb[tag] = { o: dv.getUint32(o + 8), l: dv.getUint32(o + 12) };
    }
    var h = tb.head.o, upm = dv.getUint16(h + 18);
    var bbox = [dv.getInt16(h + 36), dv.getInt16(h + 38), dv.getInt16(h + 40), dv.getInt16(h + 42)];
    var hh = tb.hhea.o, asc = dv.getInt16(hh + 4), desc = dv.getInt16(hh + 6), nHM = dv.getUint16(hh + 34);
    var hm = tb.hmtx.o;
    var cm = tb.cmap.o, nt = dv.getUint16(cm + 2), sub = -1;
    for (var j = 0; j < nt; j++) {
      var r = cm + 4 + j * 8, pid = dv.getUint16(r), eid = dv.getUint16(r + 2), off = dv.getUint32(r + 4);
      if (pid === 3 && eid === 1) { sub = cm + off; break; }
      if (pid === 0 && sub < 0) sub = cm + off;
    }
    if (sub < 0 || dv.getUint16(sub) !== 4) throw new Error('cmap');
    var segX2 = dv.getUint16(sub + 6), seg = segX2 / 2;
    var endO = sub + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, rangeO = deltaO + segX2;
    function gid(c) {
      for (var s = 0; s < seg; s++) {
        if (c <= dv.getUint16(endO + s * 2)) {
          var st = dv.getUint16(startO + s * 2);
          if (c < st) return 0;
          var ro = dv.getUint16(rangeO + s * 2), dl = dv.getInt16(deltaO + s * 2);
          if (ro === 0) return (c + dl) & 0xFFFF;
          var g = dv.getUint16(rangeO + s * 2 + ro + (c - st) * 2);
          return g === 0 ? 0 : (g + dl) & 0xFFFF;
        }
      }
      return 0;
    }
    function adv(g) { return dv.getUint16(hm + (g < nHM ? g : nHM - 1) * 4); }
    var cap = asc;
    if (tb['OS/2'] && dv.getUint16(tb['OS/2'].o) >= 2) cap = dv.getInt16(tb['OS/2'].o + 88);
    return { buf: buf, upm: upm, bbox: bbox, asc: asc, desc: desc, cap: cap, gid: gid, adv: adv };
  }

  function hex4(n) { var s = n.toString(16).toUpperCase(); return '0000'.slice(s.length) + s; }
  function sc(f, v) { return Math.round(v * 1000 / f.upm); }

  function Font(buf, res, psName) {
    this.f = parseTTF(buf); this.res = res; this.ps = psName; this.used = {};
  }
  Font.prototype.enc = function (str) {
    var out = '';
    for (var i = 0; i < str.length; i++) {
      var c = str.charCodeAt(i), g = this.f.gid(c);
      if (g && !(g in this.used)) this.used[g] = c;
      out += hex4(g);
    }
    return out;
  };
  Font.prototype.em = function (str) { // szerokość w em
    var t = 0;
    for (var i = 0; i < str.length; i++) t += this.f.adv(this.f.gid(str.charCodeAt(i)));
    return t / this.f.upm;
  };

  /* ---------- pomocnicze ---------- */
  function A(str) { var u = new Uint8Array(str.length); for (var i = 0; i < str.length; i++) u[i] = str.charCodeAt(i) & 255; return u; }
  function num(v) { return (Math.round(v * 100) / 100).toString(); }
  function col(c) { return num(c[0] / 255) + ' ' + num(c[1] / 255) + ' ' + num(c[2] / 255); }

  function zip(u8) {
    if (typeof CompressionStream === 'undefined') return Promise.resolve({ f: '', d: u8 });
    var s = new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate'));
    return new Response(s).arrayBuffer().then(function (b) { return { f: ' /Filter /FlateDecode', d: new Uint8Array(b) }; });
  }

  /* ---------- dokument ---------- */
  function Doc(fr, fb, logo) {
    this.fonts = [new Font(fr, 'F1', 'Carlito'), new Font(fb, 'F2', 'Carlito-Bold')];
    this.logo = logo; this.pages = []; this.newPage();
  }
  Doc.prototype.newPage = function () { this.ops = []; this.pages.push(this.ops); };
  Doc.prototype.width = function (s, size, bold) { return this.fonts[bold ? 1 : 0].em(s) * size / K; }; // mm
  Doc.prototype.text = function (s, x, y, o) {
    if (!s) return;
    var f = this.fonts[o.b ? 1 : 0], size = o.size || 10, w = f.em(s) * size / K;
    if (o.align === 'r') x -= w; else if (o.align === 'c') x -= w / 2;
    this.ops.push('BT /' + f.res + ' ' + size + ' Tf ' + col(o.color || [0, 0, 0]) + ' rg ' +
      num(x * K) + ' ' + num((H - y) * K) + ' Td <' + f.enc(s) + '> Tj ET');
  };
  Doc.prototype.line = function (x1, y1, x2, y2, color, wd) {
    this.ops.push(col(color) + ' RG ' + num((wd || 0.3) * K) + ' w ' + num(x1 * K) + ' ' + num((H - y1) * K) + ' m ' + num(x2 * K) + ' ' + num((H - y2) * K) + ' l S');
  };
  Doc.prototype.roundRect = function (x, y, w, h, r, color) {
    var X = x * K, Y = (H - y - h) * K, Wd = w * K, Hh = h * K, R = r * K, c = R * 0.5523, p = [];
    function P() { for (var i = 0; i < arguments.length; i++) p.push(num(arguments[i])); }
    P(X + R, Y); p.push('m'); P(X + Wd - R, Y); p.push('l');
    P(X + Wd - R + c, Y, X + Wd, Y + R - c, X + Wd, Y + R); p.push('c');
    P(X + Wd, Y + Hh - R); p.push('l');
    P(X + Wd, Y + Hh - R + c, X + Wd - R + c, Y + Hh, X + Wd - R, Y + Hh); p.push('c');
    P(X + R, Y + Hh); p.push('l');
    P(X + R - c, Y + Hh, X, Y + Hh - R + c, X, Y + Hh - R); p.push('c');
    P(X, Y + R); p.push('l');
    P(X, Y + R - c, X + R - c, Y, X + R, Y); p.push('c h');
    this.ops.push(col(color) + ' rg ' + p.join(' ') + ' f');
  };
  Doc.prototype.image = function (x, y, w, h) {
    this.ops.push('q ' + num(w * K) + ' 0 0 ' + num(h * K) + ' ' + num(x * K) + ' ' + num((H - y - h) * K) + ' cm /Im1 Do Q');
  };

  Doc.prototype.finish = function (title) {
    var self = this, objs = [null];
    function reserve() { objs.push(null); return objs.length - 1; }
    function set(id, d, data) { objs[id] = { d: d, s: data || null }; }
    function add(d, data) { var id = reserve(); set(id, d, data); return id; }

    var catalog = reserve(), pagesId = reserve(), info = reserve();
    var chain = Promise.resolve(), fontIds = [], imgId = 0, pageIds = [];

    self.fonts.forEach(function (font, idx) {
      chain = chain.then(function () { return zip(new Uint8Array(font.f.buf)); }).then(function (z) {
        var f = font.f, name = 'ESPE' + idx + 'A+' + font.ps;
        var ffId = add(' /Length1 ' + f.buf.byteLength + z.f, z.d);
        var fdId = add('<< /Type /FontDescriptor /FontName /' + name + ' /Flags 32 /FontBBox [' +
          f.bbox.map(function (v) { return sc(f, v); }).join(' ') + '] /ItalicAngle 0 /Ascent ' + sc(f, f.asc) +
          ' /Descent ' + sc(f, f.desc) + ' /CapHeight ' + sc(f, f.cap) + ' /StemV 80 /FontFile2 ' + ffId + ' 0 R >>');
        var gids = Object.keys(font.used).map(Number).sort(function (a, b) { return a - b; });
        var wArr = gids.map(function (g) { return g + ' [' + sc(f, f.adv(g)) + ']'; }).join(' ');
        var cidId = add('<< /Type /Font /Subtype /CIDFontType2 /BaseFont /' + name +
          ' /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ' + fdId +
          ' 0 R /CIDToGIDMap /Identity /DW 1000 /W [' + wArr + '] >>');
        var cm = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange\n';
        for (var i = 0; i < gids.length; i += 100) {
          var part = gids.slice(i, i + 100);
          cm += part.length + ' beginbfchar\n' + part.map(function (g) { return '<' + hex4(g) + '> <' + hex4(font.used[g]) + '>'; }).join('\n') + '\nendbfchar\n';
        }
        cm += 'endcmap CMapName currentdict /CMap defineresource pop end end';
        return zip(A(cm)).then(function (zc) {
          var tuId = add(zc.f, zc.d);
          fontIds[idx] = add('<< /Type /Font /Subtype /Type0 /BaseFont /' + name + ' /Encoding /Identity-H /DescendantFonts [' + cidId + ' 0 R] /ToUnicode ' + tuId + ' 0 R >>');
        });
      });
    });

    if (self.logo) {
      chain = chain.then(function () { return zip(self.logo.rgb); }).then(function (z) {
        imgId = add(' /Type /XObject /Subtype /Image /Width ' + self.logo.w + ' /Height ' + self.logo.h +
          ' /ColorSpace /DeviceRGB /BitsPerComponent 8' + z.f, z.d);
      });
    }

    self.pages.forEach(function (ops) {
      chain = chain.then(function () { return zip(A(ops.join('\n'))); }).then(function (z) {
        var cId = add(z.f, z.d);
        var res = '/Font << /F1 ' + fontIds[0] + ' 0 R /F2 ' + fontIds[1] + ' 0 R >>' + (imgId ? ' /XObject << /Im1 ' + imgId + ' 0 R >>' : '');
        pageIds.push(add('<< /Type /Page /Parent ' + pagesId + ' 0 R /MediaBox [0 0 ' + num(W * K) + ' ' + num(H * K) + '] /Resources << ' + res + ' >> /Contents ' + cId + ' 0 R >>'));
      });
    });

    return chain.then(function () {
      set(catalog, '<< /Type /Catalog /Pages ' + pagesId + ' 0 R >>');
      set(pagesId, '<< /Type /Pages /Kids [' + pageIds.map(function (i) { return i + ' 0 R'; }).join(' ') + '] /Count ' + pageIds.length + ' >>');
      set(info, '<< /Title (' + (title || 'Raport') + ') /Producer (eSPe Time Tracker) >>');

      var parts = [new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D, 0x31, 0x2E, 0x34, 0x0A, 0x25, 0xE2, 0xE3, 0xCF, 0xD3, 0x0A])];
      var pos = parts[0].length, offs = [];
      function push(u) { parts.push(u); pos += u.length; }
      for (var id = 1; id < objs.length; id++) {
        var o = objs[id]; offs[id] = pos;
        if (o.s) {
          push(A(id + ' 0 obj\n<<' + o.d + ' /Length ' + o.s.length + ' >>\nstream\n')); push(o.s); push(A('\nendstream\nendobj\n'));
        } else {
          push(A(id + ' 0 obj\n' + o.d + '\nendobj\n'));
        }
      }
      var xr = pos, x = 'xref\n0 ' + objs.length + '\n0000000000 65535 f \n';
      for (id = 1; id < objs.length; id++) x += ('0000000000' + offs[id]).slice(-10) + ' 00000 n \n';
      x += 'trailer\n<< /Size ' + objs.length + ' /Root ' + catalog + ' 0 R /Info ' + info + ' 0 R >>\nstartxref\n' + xr + '\n%%EOF\n';
      push(A(x));
      return new Blob(parts, { type: 'application/pdf' });
    });
  };

  /* ---------- układ raportu ---------- */
  var INK = [56, 68, 91], WINE = [132, 10, 11], MUT = [107, 118, 134], CREAM = [255, 240, 225], OK = [47, 107, 63], LINE = [230, 211, 192];
  var M = 16, R = W - M;

  function wrap(doc, str, maxW, size, bold) {
    var words = String(str).split(/\s+/), lines = [], cur = '';
    function fit(s) { return doc.width(s, size, bold) <= maxW; }
    words.forEach(function (w) {
      if (!w) return;
      var t = cur ? cur + ' ' + w : w;
      if (fit(t)) { cur = t; return; }
      if (cur) { lines.push(cur); cur = ''; }
      while (!fit(w)) { // bardzo długie słowo
        var k = w.length; while (k > 1 && !fit(w.slice(0, k))) k--;
        lines.push(w.slice(0, k)); w = w.slice(k);
      }
      cur = w;
    });
    if (cur) lines.push(cur);
    return lines.length ? lines : [''];
  }

  function render(doc, m) {
    var y = M;
    function need(h) { if (y + h > H - M - 4) { doc.newPage(); y = M; } }

    if (doc.logo) doc.image(M, y - 2, 52, 52 * doc.logo.h / doc.logo.w);
    doc.text('Wygenerowano ' + m.date, R, y + 4, { size: 9, color: MUT, align: 'r' });
    y += 15;
    doc.text(m.title, M, y + 5, { b: 1, size: 20, color: WINE });
    y += 12;
    doc.text(m.subtitle, M, y, { size: 10, color: MUT });
    y += 3; doc.line(M, y, R, y, LINE, 0.4); y += 8;

    m.weeks.forEach(function (w) {
      need(26);
      doc.roundRect(M, y, R - M, 11, 2.5, CREAM);
      doc.text(w.title, M + 4, y + 7.3, { b: 1, size: 12.5, color: INK });
      doc.text(w.total + '  ·  ' + w.earn, R - 4, y + 7.3, { b: 1, size: 11, color: WINE, align: 'r' });
      y += 16;
      if (w.goal) { doc.text(w.goal.text, M + 1, y, { b: 1, size: 10, color: w.goal.ok ? OK : WINE }); y += 6.5; }
      w.days.forEach(function (d) {
        need(18);
        doc.text(d.title, M + 1, y, { b: 1, size: 11, color: INK });
        doc.text(d.total, R - 1, y, { b: 1, size: 11, color: INK, align: 'r' });
        y += 2.2; doc.line(M, y, R, y, LINE, 0.3); y += 5.4;
        d.sessions.forEach(function (s) {
          var lines = wrap(doc, s.title, 104, 10.5, true);
          need(lines.length * 4.8 + s.pauses.length * 4.3 + 3);
          doc.text(s.time, M + 1, y, { size: 10, color: MUT });
          lines.forEach(function (ln, i) { doc.text(ln, M + 36, y + i * 4.8, { b: 1, size: 10.5, color: INK }); });
          doc.text(s.dur, R - 1, y, { b: 1, size: 10.5, color: WINE, align: 'r' });
          y += lines.length * 4.8;
          s.pauses.forEach(function (p) { doc.text(p, M + 36, y, { size: 8.8, color: MUT }); y += 4.3; });
          y += 2.4;
        });
        y += 1.5;
      });
      y += 5;
    });

    need(18);
    doc.line(M, y, R, y, INK, 0.6); y += 7;
    doc.text('Razem', M + 1, y, { b: 1, size: 13, color: INK });
    doc.text(m.total + '  ·  ' + m.earn, R - 1, y, { b: 1, size: 13, color: WINE, align: 'r' });

    var n = doc.pages.length;
    doc.pages.forEach(function (ops, i) {
      doc.ops = ops;
      doc.text('eSPe  ·  boskieksiążki.pl', M, H - 9, { size: 8, color: MUT });
      doc.text('Strona ' + (i + 1) + ' / ' + n, R, H - 9, { size: 8, color: MUT, align: 'r' });
    });
  }

  /* ---------- zasoby ---------- */
  var assets = null;
  function getBuf(u) { return fetch(u).then(function (r) { if (!r.ok) throw new Error(u); return r.arrayBuffer(); }); }
  function loadLogo() {
    return new Promise(function (res) {
      var im = new Image();
      im.onload = function () {
        try {
          var c = document.createElement('canvas'); c.width = im.naturalWidth; c.height = im.naturalHeight;
          var x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.drawImage(im, 0, 0);
          var d = x.getImageData(0, 0, c.width, c.height).data, rgb = new Uint8Array(c.width * c.height * 3);
          for (var i = 0, j = 0; i < d.length; i += 4) { rgb[j++] = d[i]; rgb[j++] = d[i + 1]; rgb[j++] = d[i + 2]; }
          res({ w: c.width, h: c.height, rgb: rgb });
        } catch (e) { res(null); }
      };
      im.onerror = function () { res(null); };
      im.src = 'logo.png';
    });
  }
  function load() {
    if (!assets) {
      assets = Promise.all([getBuf('Carlito-Regular.subset.ttf'), getBuf('Carlito-Bold.subset.ttf'), loadLogo()])
        .then(function (a) { return { fr: a[0], fb: a[1], logo: a[2] }; })
        .catch(function (e) { assets = null; throw e; });
    }
    return assets;
  }
  function build(model) {
    return load().then(function (a) {
      var doc = new Doc(a.fr, a.fb, a.logo);
      render(doc, model);
      return doc.finish(model.title);
    });
  }

  window.EspePdf = { load: load, build: build };
})();
