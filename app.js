/* app.js : หน้าจอของเว็บลบลายน้ำ ตัวลบจริงอยู่ core.js ไฟล์ไม่ถูกส่งออกไปไหน
 * ขั้นงาน: เลือกไฟล์ → ตรวจ → เลือกชนิดที่จะลบ + ดูหน้าตัวอย่าง → ลบ + ตรวจข้อความครบ → ดูก่อน/หลัง → ดาวน์โหลด */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var drop = $("drop"), input = $("file"), list = $("results"), status = $("status");
  var MB = 1024 * 1024, MAX_BYTES = 200 * MB, PREVIEW_W = 300;
  var pdfjs = window.pdfjsLib;
  /* PDF.js จัดการวงจร worker ของแต่ละเอกสารเอง เมื่อ destroy() แล้วเปิดเอกสารใหม่ได้ */
  pdfjs.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";

  var KINDS = [
    { key: "annot", label: "ลายน้ำพื้นหลัง (วัตถุซ้อนบนหน้า)", unit: "จุด" },
    { key: "layer", label: "ลายน้ำใน layer ชื่อ Watermark", unit: "ก้อน" },
    { key: "stamp", label: "รูปที่วางซ้ำเกือบทุกหน้า (อาจเป็นโลโก้จริง)", unit: "จุด" }
  ];

  function say(text) { status.textContent = text; }
  function th(n) { return n.toLocaleString("th-TH"); }
  function fmtSize(n) {
    if (n < MB / 10) return Math.max(1, Math.round(n / 1024)).toLocaleString("th-TH") + " KB";
    return (n / MB).toLocaleString("th-TH", { maximumFractionDigits: 1 }) + " MB";
  }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function icon(id) {
    var NS = "http://www.w3.org/2000/svg", svg = document.createElementNS(NS, "svg"), use = document.createElementNS(NS, "use");
    svg.setAttribute("class", "ic"); svg.setAttribute("aria-hidden", "true");
    use.setAttribute("href", "#" + id); svg.appendChild(use);
    return svg;
  }
  function button(label, iconId, cls, fn) {
    var b = el("button", "btn " + (cls || ""));
    b.type = "button";
    b.appendChild(icon(iconId));
    b.appendChild(document.createTextNode(label));
    b.addEventListener("click", function () { fn(b); });
    return b;
  }
  function outName(name) { return name.replace(/\.pdf$/i, "") + "_ไม่มีลายน้ำ.pdf"; }
  function save(bytes, name) {
    var url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    var a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }
  function why(err) {
    var m = String(err && err.message || err);
    if (/encrypt|password/i.test(m)) return "ไฟล์นี้ตั้งรหัสผ่านไว้ ปลดรหัสก่อนแล้วเลือกใหม่";
    if (m.indexOf("SIGNED_PDF") !== -1) return "ไฟล์นี้มีลายเซ็นดิจิทัล การแก้ PDF จะทำให้ลายเซ็นใช้ยืนยันไม่ได้ จึงไม่แก้ไฟล์นี้";
    if (m.indexOf("UNSUPPORTED_INLINE_IMAGE") !== -1) return "ไฟล์มีรูปแบบภาพฝังในคำสั่ง PDF ที่เครื่องมือนี้อ่านอย่างปลอดภัยไม่ได้ จึงไม่แก้ไฟล์นี้";
    if (/worker/i.test(m)) return "ตัวอ่าน PDF ในเบราว์เซอร์ขัดข้อง โหลดหน้าเว็บใหม่แล้วลองอีกครั้ง";
    return "อ่านไฟล์นี้ไม่ได้ ไฟล์อาจเสียหรือไม่ใช่ PDF ลองเปิดด้วยโปรแกรมอ่าน PDF แล้วบันทึกใหม่ก่อน";
  }

  /* วาดหน้าเดียวลง canvas สำหรับดูตัวอย่าง */
  async function renderPage(bytes, pageNo, canvas) {
    var doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, disableFontFace: true }).promise;
    try {
      var page = await doc.getPage(pageNo);
      var vp1 = page.getViewport({ scale: 1 });
      var scale = PREVIEW_W / vp1.width * (window.devicePixelRatio || 1);
      var vp = page.getViewport({ scale: scale });
      canvas.width = vp.width; canvas.height = vp.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp, annotationMode: pdfjs.AnnotationMode.ENABLE }).promise;
    } finally { doc.destroy(); }
  }

  function makeCard(file) {
    var li = $("row").content.firstElementChild.cloneNode(true);
    li.querySelector(".res-name").textContent = file.name;
    li.querySelector(".res-meta").textContent = fmtSize(file.size);
    list.prepend(li);
    var q = function (sel) { return li.querySelector(sel); };
    return {
      li: li, q: q,
      msg: function (text, kind) { var p = q(".res-msg"); p.textContent = text; p.className = "res-msg" + (kind ? " " + kind : ""); },
      progress: function (done, total) {
        var bar = q(".bar");
        bar.hidden = total === 0;
        bar.firstElementChild.style.width = Math.round(done / Math.max(total, 1) * 100) + "%";
        bar.setAttribute("aria-valuenow", String(Math.round(done / Math.max(total, 1) * 100)));
      },
      actions: function (nodes) { var box = q(".res-act"); box.textContent = ""; nodes.forEach(function (n) { box.appendChild(n); }); }
    };
  }

  async function handle(file) {
    var card = makeCard(file);
    if (file.size > MAX_BYTES) {
      card.msg("ไฟล์ใหญ่เกิน " + fmtSize(MAX_BYTES) + " เบราว์เซอร์อาจค้าง แบ่งไฟล์ก่อนแล้วลองใหม่", "bad");
      return;
    }
    var bytes = new Uint8Array(await file.arrayBuffer());
    if (String.fromCharCode.apply(null, bytes.subarray(0, 5)) !== "%PDF-") {
      card.msg("ไฟล์นี้ไม่ใช่ PDF เลือกไฟล์ที่ลงท้าย .pdf", "bad");
      say(file.name + " ไม่ใช่ PDF");
      return;
    }
    card.msg("กำลังตรวจหาลายน้ำ...");
    card.progress(0, 1);
    var result;
    try {
      result = await Unwatermark.scan(bytes, card.progress);
    } catch (err) {
      card.progress(0, 0); card.msg(why(err), "bad"); say(file.name + ": " + why(err));
      return;
    }
    card.progress(0, 0);
    card.q(".res-meta").textContent = fmtSize(file.size) + " · " + th(result.pageCount) + " หน้า";
    var f = result.found, total = f.annot + f.layer + f.stamp;
    if (!total) {
      card.msg("ไม่พบลายน้ำที่ลบได้ ถ้าลายน้ำติดอยู่ในภาพสแกน เครื่องมือนี้ลบไม่ได้");
      say(file.name + ": ไม่พบลายน้ำ");
      return;
    }
    card.msg("พบสิ่งที่อาจเป็นลายน้ำ " + th(total) + " จุด เลือกชนิดที่จะลบเพื่อดูตัวอย่างก่อนกดลบ");
    say(file.name + ": พบลายน้ำ " + th(total) + " จุด");

    /* ช่องเลือกชนิด (ติ๊กไว้ทุกชนิดที่เจอ) */
    var fs = card.q(".kinds");
    fs.hidden = false;
    card.q(".pv-note").hidden = !f.annot;
    KINDS.forEach(function (k) {
      if (!f[k.key]) return;
      var label = el("label", "choice");
      var box = el("input", "check"); box.type = "checkbox"; box.checked = k.key !== "stamp"; box.value = k.key;
      label.appendChild(box);
      label.appendChild(document.createTextNode(k.label + " " + th(f[k.key]) + " " + k.unit));
      fs.appendChild(label);
    });
    var kindErr = el("p", "error-text"); kindErr.hidden = true; kindErr.setAttribute("role", "alert");
    fs.appendChild(kindErr);

    /* ตัวอย่างหน้าแรกที่มีชนิดลายน้ำซึ่งเลือกไว้ เปลี่ยนตาม checkbox */
    var hitPage = result.firstHit + 1, previewSeq = 0, previewChain = Promise.resolve();
    card.q(".pv").hidden = false;
    var removeBtn = button("ลบลายน้ำ", "i-check", "pri", async function (btn) {
      var kinds = {};
      fs.querySelectorAll("input:checked").forEach(function (b) { kinds[b.value] = true; });
      if (!Object.keys(kinds).length) {
        kindErr.hidden = false;
        kindErr.textContent = "ยังไม่ได้เลือกชนิดไหนเลย ติ๊กอย่างน้อย 1 ชนิดก่อนกดลบ";
        fs.querySelector("input").focus();
        return;
      }
      kindErr.hidden = true;
      btn.disabled = true;
      fs.querySelectorAll("input").forEach(function (b) { b.disabled = true; });
      try {
        card.msg("กำลังลบลายน้ำ...");
        var out = await Unwatermark.clean(result, kinds, card.progress);
        card.msg("กำลังตรวจว่าข้อความทุกหน้ายังครบ...");
        var check = await Unwatermark.verifyText(pdfjs, bytes, out.bytes, out.layerPages, card.progress);
        var bad = check.bad;
        card.progress(0, 0);
        if (bad.length) {
          card.msg("หยุดไว้ก่อน: หลังลบแล้วข้อความไม่ตรงต้นฉบับ " + th(bad.length) + " หน้า (เช่น หน้า " +
                   bad.slice(0, 5).join(", ") + ") จึงไม่ให้ดาวน์โหลด ลองเอาติ๊กบางชนิดออกแล้วกดลบใหม่", "bad");
          result = await Unwatermark.scan(bytes);
          btn.disabled = false;
          fs.querySelectorAll("input").forEach(function (b) { b.disabled = false; });
          say(file.name + ": หยุด ข้อความไม่ครบ");
          return;
        }
        var removed = (kinds.annot ? f.annot : 0) + (kinds.layer ? f.layer : 0) + (kinds.stamp ? f.stamp : 0);
        var coverage = check.textPages === 0
          ? "ไฟล์นี้ไม่มีข้อความที่ดึงได้ จึงตรวจเนื้อหาภาพสแกนอัตโนมัติไม่ได้"
          : "ข้อความที่ดึงได้ตรงต้นฉบับ " + th(check.textPages) + " หน้า";
        card.msg("ลบแล้ว " + th(removed) + " จุด " + coverage + " ดูหน้าหลังลบและตรวจไฟล์ผลลัพธ์ก่อนนำไปใช้", "ok");
        card.q(".pv-after-fig").hidden = false;
        card.q(".pv-after-cap").textContent = "หลังลบ (หน้า " + th(hitPage) + ")";
        try {
          await renderPage(out.bytes, hitPage, card.q(".pv-after"));
        } catch (previewErr) {
          card.msg("ตรวจข้อความผ่าน แต่แสดงตัวอย่างหลังลบไม่ได้ จึงยังไม่ให้ดาวน์โหลด โหลดหน้าเว็บใหม่แล้วลองอีกครั้ง", "bad");
          card.actions([]);
          say(file.name + ": แสดงตัวอย่างหลังลบไม่ได้");
          return;
        }
        var dl = button("ดาวน์โหลด PDF", "i-download", "pri", function () {
          save(out.bytes, outName(file.name));
          say("ดาวน์โหลด " + outName(file.name) + " แล้ว");
        });
        card.actions([dl]);
        dl.focus();
        say("ลบลายน้ำ " + file.name + " เสร็จ พร้อมดาวน์โหลด");
      } catch (err) {
        card.progress(0, 0);
        try { result = await Unwatermark.scan(bytes); btn.disabled = false; }
        catch (_) { card.actions([]); }
        fs.querySelectorAll("input").forEach(function (b) { b.disabled = false; });
        card.msg("ลบไม่สำเร็จ: " + why(err) + " กดลองใหม่ได้", "bad");
      }
    });
    card.actions([removeBtn]);
    function updatePreview() {
      var selected = {};
      fs.querySelectorAll("input:checked").forEach(function (b) { selected[b.value] = true; });
      var idx = result.pages.findIndex(function (p) {
        return (selected.annot && p.annots) || (selected.layer && p.blocks) || (selected.stamp && p.stamps);
      });
      card.q(".pv").hidden = idx < 0;
      removeBtn.disabled = true;
      if (idx < 0) return;
      hitPage = idx + 1;
      card.q(".pv-before-cap").textContent = "กำลังแสดงตัวอย่างหน้า " + th(hitPage) + "...";
      var seq = ++previewSeq, pageNo = hitPage;
      previewChain = previewChain.catch(function () {}).then(function () {
        return renderPage(bytes, pageNo, card.q(".pv-before"));
      });
      previewChain.then(function () {
        if (seq === previewSeq) {
          card.q(".pv-before-cap").textContent = "ก่อนลบ (หน้า " + th(hitPage) + ")";
          removeBtn.disabled = false;
        }
      }).catch(function () {
        if (seq !== previewSeq) return;
        card.msg("แสดงตัวอย่างก่อนลบไม่ได้ จึงยังไม่ลบไฟล์นี้ โหลดหน้าเว็บใหม่แล้วลองอีกครั้ง", "bad");
        card.actions([]);
      });
    }
    fs.addEventListener("change", updatePreview);
    updatePreview();
  }

  function take(files) { Array.prototype.forEach.call(files, function (f) { handle(f); }); }

  input.addEventListener("change", function () { take(input.files); input.value = ""; });
  ["dragenter", "dragover"].forEach(function (ev) {
    document.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add("over"); });
  });
  document.addEventListener("dragleave", function (e) {
    if (!e.relatedTarget) drop.classList.remove("over");
  });
  document.addEventListener("drop", function (e) {
    e.preventDefault(); drop.classList.remove("over");
    if (e.dataTransfer && e.dataTransfer.files.length) take(e.dataTransfer.files);
  });
})();
