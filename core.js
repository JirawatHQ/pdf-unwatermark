/* core.js : ตัวลบลายน้ำ PDF ที่ทำงานในเบราว์เซอร์ล้วน (ไม่มีการส่งไฟล์ไปไหน)
 *
 * จับ 4 แบบ:
 *   1. annotation ชนิด /Watermark
 *   2. บล็อกใน content stream หรือ Form XObject ที่อยู่ใน layer (OCG) ชื่อ watermark/ลายน้ำ
 *   3. ตราประทับ = รูปเดียวกันที่วางบน >= 90% ของหน้า (อย่างน้อย 3 หน้า) และกินพื้นที่ < 50% ของหน้า
 *   4. บล็อกข้อความโปร่งใสที่วางคำเดียวกันซ้ำเฉียงในหน้าเดียว
 * ใช้ได้ทั้งในเบราว์เซอร์ (window.Unwatermark) และใน Node (require) สำหรับเทสต์
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./vendor/pdf-lib.min.js"));
  else root.Unwatermark = factory(root.PDFLib);
})(typeof self !== "undefined" ? self : this, function (PDFLib) {
  "use strict";
  var PDFName = PDFLib.PDFName, PDFDict = PDFLib.PDFDict, PDFArray = PDFLib.PDFArray,
      PDFRef = PDFLib.PDFRef, PDFRawStream = PDFLib.PDFRawStream;

  var STAMP_SHARE = 0.9, STAMP_MIN_PAGES = 3, STAMP_MAX_AREA = 0.5;   /* ตรงกับ scripts/pdf_clean.py */

  /* ── ตัวแยกคำสั่งใน content stream ─────────────────────────────────────────
   * ทำงานกับสตริง latin1 (1 ตัวอักษร = 1 byte) เก็บช่วง [start,end) ของแต่ละคำสั่ง
   * เพื่อเขียนกลับด้วย byte เดิมทุกตัว ไม่ต้องแปลงค่ากลับเป็นข้อความเอง */
  var WS = "\0\t\n\f\r ", DELIM = "()<>[]{}/%";

  function isWS(c) { return WS.indexOf(c) !== -1; }
  function isRegular(c) { return c !== undefined && !isWS(c) && DELIM.indexOf(c) === -1; }

  function Lexer(s) { this.s = s; this.i = 0; }
  Lexer.prototype.skip = function () {
    var s = this.s;
    for (;;) {
      while (this.i < s.length && isWS(s[this.i])) this.i++;
      if (s[this.i] !== "%") return;
      while (this.i < s.length && s[this.i] !== "\n" && s[this.i] !== "\r") this.i++;
    }
  };
  /* คืนค่า operand หนึ่งตัว หรือ {op: "..."} ถ้าเป็นคำสั่ง หรือ null เมื่อหมด */
  Lexer.prototype.next = function () {
    this.skip();
    var s = this.s, c = s[this.i];
    if (c === undefined) return null;
    if (c === "/") {
      var j = ++this.i;
      while (isRegular(s[this.i])) this.i++;
      return { name: s.slice(j, this.i) };
    }
    if (c === "(") {
      var depth = 0;
      do {
        if (s[this.i] === "\\") this.i++;
        else if (s[this.i] === "(") depth++;
        else if (s[this.i] === ")") depth--;
        this.i++;
      } while (depth > 0 && this.i < s.length);
      return { str: true };
    }
    if (c === "<" && s[this.i + 1] === "<") {
      this.i += 2;
      var dict = {};
      for (;;) {
        this.skip();
        if (s[this.i] === ">" && s[this.i + 1] === ">") { this.i += 2; return { dict: dict }; }
        var k = this.next();
        if (k === null) return { dict: dict };
        var v = this.next();
        if (k.name !== undefined) dict[k.name] = v;
      }
    }
    if (c === "<") {
      var e = s.indexOf(">", this.i);
      this.i = e === -1 ? s.length : e + 1;
      return { str: true };
    }
    if (c === "[") {
      this.i++;
      var arr = [];
      for (;;) {
        this.skip();
        if (s[this.i] === "]" || this.i >= s.length) { this.i++; return { arr: arr }; }
        arr.push(this.next());
      }
    }
    if (c === "]" || c === ">" || c === ")" || c === "{" || c === "}") { this.i++; return this.next(); }
    var st = this.i;
    while (isRegular(s[this.i])) this.i++;
    var word = s.slice(st, this.i);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) return { num: parseFloat(word) };
    if (word === "true" || word === "false" || word === "null") return { lit: word };
    return { op: word };
  };

  /* แตก content stream เป็นรายการ {op, args, start, end} */
  function parseOps(s) {
    var lx = new Lexer(s), ops = [], args = [], start = null;
    for (;;) {
      lx.skip();
      var at = lx.i, t = lx.next();
      if (t === null) break;
      if (start === null) start = at;
      if (t.op === undefined) { args.push(t); continue; }
      if (t.op === "BI") {
        /* ไบต์ข้อมูลภาพอาจมี " EI " อยู่ภายใน ตัวแยกทั่วไปเดาจุดจบไม่ได้อย่างปลอดภัย */
        throw new Error("UNSUPPORTED_INLINE_IMAGE");
      }
      ops.push({ op: t.op, args: args, start: start, end: lx.i });
      args = []; start = null;
    }
    return ops;
  }

  /* ── ตัวช่วยฝั่ง pdf-lib ──────────────────────────────────────────────── */
  function bytesToLatin1(u8) {
    var out = "", CH = 0x8000;
    for (var i = 0; i < u8.length; i += CH) out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return out;
  }
  function latin1ToBytes(s) {
    var u8 = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i) & 0xff;
    return u8;
  }
  function streamBytes(stream) {
    if (stream instanceof PDFRawStream) return PDFLib.decodePDFRawStream(stream).decode();
    if (typeof stream.getContents === "function") return stream.getContents();
    return new Uint8Array(0);
  }
  function pageContent(ctx, node) {
    var c = node.get(PDFName.of("Contents"));
    if (!c) return "";
    var obj = ctx.lookup(c), parts = [];
    if (obj instanceof PDFArray) {
      for (var i = 0; i < obj.size(); i++) parts.push(bytesToLatin1(streamBytes(ctx.lookup(obj.get(i)))));
    } else if (obj) {
      parts.push(bytesToLatin1(streamBytes(obj)));
    }
    return parts.join("\n");                   /* สเปก PDF: หลาย stream = ต่อกันเป็นก้อนเดียว */
  }
  /* Resources สืบทอดจากโหนดแม่ได้ */
  function resources(ctx, node) {
    for (var n = node; n; n = ctx.lookup(n.get(PDFName.of("Parent")))) {
      var r = n.get(PDFName.of("Resources"));
      if (r) return ctx.lookup(r, PDFDict);
    }
    return null;
  }
  function subDict(ctx, dict, key) {
    if (!dict) return null;
    var v = dict.get(PDFName.of(key));
    return v ? ctx.lookup(v) : null;
  }
  function nameOf(obj) { return obj ? String(obj.asString ? obj.asString() : obj).replace(/^\//, "") : ""; }
  function textOf(obj) {
    if (!obj) return "";
    if (typeof obj.decodeText === "function") return obj.decodeText();
    return String(obj);
  }

  /* ไล่คำสั่งวาดรูป คืน [{idx, name, area}] พร้อมติดตามเมทริกซ์ (q/Q/cm) */
  function draws(ops, pageArea) {
    var ctm = [1, 0, 0, 1, 0, 0], stack = [], out = [];
    ops.forEach(function (o, i) {
      if (o.op === "q") stack.push(ctm);
      else if (o.op === "Q") { if (stack.length) ctm = stack.pop(); }
      else if (o.op === "cm" && o.args.length === 6) {
        var a = o.args.map(function (x) { return x.num || 0; });
        var A = ctm;
        ctm = [a[0] * A[0] + a[1] * A[2], a[0] * A[1] + a[1] * A[3],
               a[2] * A[0] + a[3] * A[2], a[2] * A[1] + a[3] * A[3],
               a[4] * A[0] + a[5] * A[2] + A[4], a[4] * A[1] + a[5] * A[3] + A[5]];
      } else if (o.op === "Do" && o.args[0] && o.args[0].name !== undefined) {
        out.push({ idx: i, name: o.args[0].name, area: Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]) / pageArea });
      }
    });
    return out;
  }

  /* BDC นี้เปิดบล็อกลายน้ำไหม */
  function isWmMarker(ctx, o, props) {
    if (o.args.length < 2 || o.args[0].name === undefined) return false;
    var tag = o.args[0].name, arg = o.args[1];
    if (tag === "Artifact") {
      return !!(arg.dict && arg.dict.Subtype && arg.dict.Subtype.name === "Watermark");
    }
    if (tag === "OC") {
      var name = "";
      if (arg.name !== undefined && props) {
        var ocg = subDict(ctx, props, arg.name);
        if (ocg instanceof PDFDict) name = textOf(ctx.lookup(ocg.get(PDFName.of("Name"))));
      }
      name = name.toLowerCase();
      return name.indexOf("watermark") !== -1 || name.indexOf("ลายน้ำ") !== -1;
    }
    return false;
  }

  function imageKey(ctx, xobjs, name) {
    if (!xobjs) return null;
    var ref = xobjs.get(PDFName.of(name));
    if (!(ref instanceof PDFRef)) return null;
    var xo = ctx.lookup(ref);
    var dict = xo && xo.dict;
    if (!dict || nameOf(dict.get(PDFName.of("Subtype"))) !== "Image") return null;
    return ref.toString();
  }

  /* Some publishers attach /OC to a Form XObject instead of wrapping its Do in BDC.
   * Remove only a Form explicitly assigned to an OCG named Watermark. */
  function watermarkOC(ctx, oc) {
    oc = oc && ctx.lookup(oc);
    if (!(oc instanceof PDFDict)) return false;
    var type = nameOf(oc.get(PDFName.of("Type")));
    if (type === "OCG") {
      var title = textOf(ctx.lookup(oc.get(PDFName.of("Name")))).toLowerCase();
      return title.indexOf("watermark") !== -1 || title.indexOf("ลายน้ำ") !== -1;
    }
    if (type !== "OCMD") return false;
    var groups = oc.get(PDFName.of("OCGs"));
    groups = groups && ctx.lookup(groups);
    if (groups instanceof PDFArray) {
      for (var i = 0; i < groups.size(); i++) if (watermarkOC(ctx, groups.get(i))) return true;
      return false;
    }
    return watermarkOC(ctx, groups);
  }
  function isWatermarkForm(ctx, xobjs, name) {
    var form = subDict(ctx, xobjs, name);
    return !!(form && form.dict && nameOf(form.dict.get(PDFName.of("Subtype"))) === "Form" &&
      watermarkOC(ctx, form.dict.get(PDFName.of("OC"))));
  }

  /* A self-contained, faint text block repeated diagonally on the same page.
   * Only remove the inner q/Q block after checking every drawing command inside. */
  function repeatedTextBlocks(ctx, ops, src, res) {
    var states = subDict(ctx, res, "ExtGState"), stack = [], drop = {}, count = 0;
    ops.forEach(function (o, i) {
      if (o.op === "q") stack.push(i);
      if (o.op !== "Q" || !stack.length) return;
      var start = stack.pop(), block = ops.slice(start, i + 1);
      var allowed = { q: 1, Q: 1, gs: 1, rg: 1, BT: 1, ET: 1, Tf: 1, Tm: 1, Tj: 1 };
      if (block.some(function (x) { return !allowed[x.op]; })) return;
      if (block.filter(function (x) { return x.op === "q"; }).length !== 1) return;
      var gsOps = block.filter(function (x) { return x.op === "gs"; });
      var texts = block.filter(function (x) { return x.op === "Tj"; });
      var matrix = block.filter(function (x) { return x.op === "Tm" && x.args.length === 6 &&
        Math.abs(x.args[1].num || 0) > 0.2 && Math.abs(x.args[2].num || 0) > 0.2; });
      if (gsOps.length !== 1 || texts.length < 3 || matrix.length < texts.length) return;
      var key = gsOps[0].args[0] && gsOps[0].args[0].name;
      var gs = key && subDict(ctx, states, key);
      var alpha = gs && gs.get && ctx.lookup(gs.get(PDFName.of("ca")));
      if (!alpha || typeof alpha.asNumber !== "function" || alpha.asNumber() > 0.3) return;
      var samples = texts.map(function (x) { return src.slice(x.start, x.end).replace(/\s*Tj\s*$/, "").trim(); });
      if (samples[0].length < 6 || samples.some(function (x) { return x !== samples[0]; })) return;
      for (var j = start; j <= i; j++) drop[j] = 1;
      count++;
    });
    return { drop: drop, count: count };
  }

  /* ── ตัวหลัก ───────────────────────────────────────────────────────────
   * scan(bytes) → {doc, pages:[…], found:{annot, layer, stamp, text}} ใช้ต่อด้วย clean()
   * onProgress(done, total) เรียกทุกหน้า */
  async function scan(bytes, onProgress) {
    var doc = await PDFLib.PDFDocument.load(bytes, { updateMetadata: false });
    var ctx = doc.context, pages = doc.getPages(), info = [];
    /* การเขียน PDF ใหม่ทำให้ลายเซ็นดิจิทัลเดิมใช้ยืนยันไม่ได้ จึงหยุดก่อนแตะไฟล์ */
    if (ctx.enumerateIndirectObjects().some(function (entry) {
      var obj = entry[1];
      return obj instanceof PDFDict && (obj.has(PDFName.of("ByteRange")) ||
        nameOf(obj.get(PDFName.of("FT"))) === "Sig");
    })) throw new Error("SIGNED_PDF");
    var stampCount = {};
    for (var p = 0; p < pages.length; p++) {
      var node = pages[p].node, box = pages[p].getMediaBox();
      var res = resources(ctx, node);
      var src = pageContent(ctx, node), ops = parseOps(src);
      var xobjs = subDict(ctx, res, "XObject"), props = subDict(ctx, res, "Properties");
      var d = draws(ops, Math.abs(box.width * box.height) || 1);
      var seen = {};
      d.forEach(function (x) {
        var key = imageKey(ctx, xobjs, x.name);
        x.key = key;
        if (key && x.area < STAMP_MAX_AREA && !seen[key]) { seen[key] = 1; stampCount[key] = (stampCount[key] || 0) + 1; }
      });
      /* annotation ลายน้ำ */
      var annots = node.Annots ? node.Annots() : null, wmAnnots = 0;
      if (annots) {
        for (var a = 0; a < annots.size(); a++) {
          var an = ctx.lookup(annots.get(a));
          if (an instanceof PDFDict && nameOf(an.get(PDFName.of("Subtype"))) === "Watermark") wmAnnots++;
        }
      }
      /* บล็อกลายน้ำใน content stream */
      var dropLayer = {}, depth = 0, blocks = 0;
      ops.forEach(function (o, i) {
        if (depth) {
          dropLayer[i] = 1;
          if (o.op === "BDC" || o.op === "BMC") depth++;
          else if (o.op === "EMC") depth--;
        } else if (o.op === "BDC" && isWmMarker(ctx, o, props)) {
          dropLayer[i] = 1; depth = 1; blocks++;
        }
      });
      d.forEach(function (x) {
        if (isWatermarkForm(ctx, xobjs, x.name) && !dropLayer[x.idx]) {
          dropLayer[x.idx] = 1; blocks++;
        }
      });
      var repeated = repeatedTextBlocks(ctx, ops, src, res);
      info.push({ ops: ops, draws: d, dropLayer: dropLayer, dropText: repeated.drop,
        textBlocks: repeated.count, dropStamp: {}, blocks: blocks, annots: wmAnnots });
      if (onProgress) onProgress(p + 1, pages.length * 2);
      if (p % 20 === 19) await new Promise(function (r) { setTimeout(r, 0); });  /* ให้หน้าจอขยับ */
    }
    var need = Math.max(STAMP_MIN_PAGES, STAMP_SHARE * pages.length), stamps = {};
    Object.keys(stampCount).forEach(function (k) { if (stampCount[k] >= need) stamps[k] = 1; });
    var found = { annot: 0, layer: 0, stamp: 0, text: 0 };
    info.forEach(function (pg) {
      pg.stamps = 0;
      pg.draws.forEach(function (x) { if (x.key && stamps[x.key]) { pg.dropStamp[x.idx] = 1; pg.stamps++; } });
      found.annot += pg.annots; found.layer += pg.blocks; found.stamp += pg.stamps;
      found.text += pg.textBlocks;
    });
    var firstHit = -1;
    info.forEach(function (pg, i) { if (firstHit < 0 && (pg.annots || pg.blocks || pg.stamps || pg.textBlocks)) firstHit = i; });
    return { doc: doc, pages: info, found: found, pageCount: pages.length, firstHit: firstHit };
  }

  /* kinds = {annot, layer, stamp, text} เลือกได้ว่าจะลบชนิดไหน (ค่าตั้งต้น ลบทุกชนิด)
   * คืน {bytes, layerPages} — layerPages = เลขหน้า (เริ่ม 1) ที่ตัดบล็อก layer ข้อความหายได้โดยตั้งใจ */
  async function clean(result, kinds, onProgress) {
    kinds = kinds || { annot: true, layer: true, stamp: true, text: true };
    var doc = result.doc, ctx = doc.context, pages = doc.getPages(), layerPages = [];
    for (var p = 0; p < pages.length; p++) {
      var node = pages[p].node, pg = result.pages[p];
      var drop = {};
      if (kinds.layer) Object.keys(pg.dropLayer).forEach(function (k) { drop[k] = 1; });
      if (kinds.text) Object.keys(pg.dropText).forEach(function (k) { drop[k] = 1; });
      if (kinds.stamp) Object.keys(pg.dropStamp).forEach(function (k) { drop[k] = 1; });
      if ((kinds.layer && pg.blocks) || (kinds.text && pg.textBlocks)) layerPages.push(p + 1);
      if (kinds.annot && pg.annots) {
        var annots = node.Annots(), keep = [];
        for (var a = 0; a < annots.size(); a++) {
          var an = ctx.lookup(annots.get(a));
          if (!(an instanceof PDFDict && nameOf(an.get(PDFName.of("Subtype"))) === "Watermark")) keep.push(annots.get(a));
        }
        if (keep.length) node.set(PDFName.of("Annots"), ctx.obj(keep));
        else node.delete(PDFName.of("Annots"));
      }
      if (Object.keys(drop).length) {
        var src = pageContent(ctx, node), parts = [];
        pg.ops.forEach(function (o, i) { if (!drop[i]) parts.push(src.slice(o.start, o.end)); });
        var stream = ctx.flateStream(latin1ToBytes(parts.join("\n")));
        node.set(PDFName.of("Contents"), ctx.register(stream));
      }
      if (onProgress) onProgress(pages.length + p + 1, pages.length * 2);
      if (p % 20 === 19) await new Promise(function (r) { setTimeout(r, 0); });
    }
    return { bytes: await doc.save(), layerPages: layerPages };
  }

  /* ── ด่านกันเนื้อหาหาย ─────────────────────────────────────────────────
   * เทียบข้อความทุกหน้าก่อน-หลังด้วย pdf.js (ตัวแยกคนละตัวกับที่ใช้ลบ)
   * หน้าทั่วไปต้องเหมือนเดิมทุกตัวอักษร หน้าที่ตัดบล็อก layer ได้แค่ "หายบางตัว" ห้ามเพิ่มหรือสลับ
   * คืน {bad, textPages} โดย textPages คือจำนวนหน้าที่ดึงข้อความได้จากต้นฉบับ */
  function isSubsequence(small, big) {
    var j = 0;
    for (var i = 0; i < big.length && j < small.length; i++) if (big[i] === small[j]) j++;
    return j === small.length;
  }
  async function pageTexts(pdfjs, bytes, onPage) {
    var doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, disableFontFace: true }).promise;
    var out = [];
    try {
      for (var i = 1; i <= doc.numPages; i++) {
        var page = await doc.getPage(i);
        var tc = await page.getTextContent();
        out.push(tc.items.map(function (x) { return x.str || ""; }).join("").replace(/\s+/g, ""));
        page.cleanup();
        if (onPage) onPage(i, doc.numPages);
      }
    } finally { doc.destroy(); }
    return out;
  }
  async function verifyText(pdfjs, before, after, layerPages, onProgress) {
    var half = function (base) { return function (i, n) { if (onProgress) onProgress(base + i, n * 2); }; };
    var a = await pageTexts(pdfjs, before, half(0));
    var b = await pageTexts(pdfjs, after, half(a.length));
    var lp = {}, bad = [];
    (layerPages || []).forEach(function (n) { lp[n] = 1; });
    var textPages = a.filter(function (t) { return t.length > 0; }).length;
    if (a.length !== b.length) return { bad: a.map(function (_, i) { return i + 1; }), textPages: textPages };
    for (var i = 0; i < a.length; i++) {
      var ok = lp[i + 1] ? isSubsequence(b[i], a[i]) : a[i] === b[i];
      if (!ok) bad.push(i + 1);
    }
    return { bad: bad, textPages: textPages };
  }

  return { scan: scan, clean: clean, verifyText: verifyText, parseOps: parseOps };
});
