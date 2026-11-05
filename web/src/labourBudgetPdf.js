import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

// Builds the Labour Budget PDF a field crew references on site: no dollar
// figures, hours rounded down to the nearest 15 min, broken up by sub job —
// same pdf-lib pattern TALLY's exportPdf.js already proves live. Built
// entirely in the browser from the shaped data worker/src/labour-budget.js
// returns; nothing new is stored or sent anywhere.
//
// Ben's explicit layout ask (2026-11-05): every column fits on one page
// WIDTH (landscape, not multiple sheets across); a sub job's own header row
// is redrawn at the top of any new page its rows spill onto, so nobody loses
// track of which group they're reading mid-page-break.

const PAGE_W = 792; // US Letter, landscape
const PAGE_H = 612;
const M = 36;
const INK = rgb(0.1, 0.1, 0.1);
const MUTED = rgb(0.4, 0.4, 0.4);
const ORANGE = rgb(0.886, 0.529, 0.102);
const RULE = rgb(0.82, 0.82, 0.82);
const HEAD_BG = rgb(0.95, 0.93, 0.89);
const GROUP_BG = rgb(0.91, 0.91, 0.91);

const safe = (s) =>
  String(s ?? "")
    .replace(/[–—]/g, "-")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");

const hoursText = (h) => (h === null || h === undefined ? "—" : Number.isInteger(h) ? String(h) : h.toFixed(2));

function wrap(text, font, size, maxWidth) {
  const out = [];
  for (const para of safe(text).split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const trial = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(trial, size) <= maxWidth) {
        line = trial;
        continue;
      }
      if (line) out.push(line);
      line = word;
    }
    out.push(line);
  }
  return out.length ? out : [""];
}

const COLS = [
  { key: "description", h: "Description", w: 310 },
  { key: "budget_code", h: "Budget Code", w: 150 },
  { key: "quantity", h: "Qty", w: 70, right: true },
  { key: "uom", h: "UoM", w: 70 },
  { key: "hours", h: "Hours", w: 90, right: true },
];

// data: { project: {name, project_number, po_number, customer}, proposal: {name, quote_nr} | null, groups: [{sub_job, items}] }
export async function buildLabourBudgetPdf(data) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const generated = new Date().toISOString().slice(0, 10);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - M;
  const text = (t, x, yy, { size = 9, f = font, color = INK } = {}) => page.drawText(safe(t), { x, y: yy, size, font: f, color });

  const tableW = COLS.reduce((a, c) => a + c.w, 0);
  const x0 = M + (PAGE_W - 2 * M - tableW) / 2;

  function newPage() {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y = PAGE_H - M;
    page.drawRectangle({ x: 0, y: PAGE_H - 8, width: PAGE_W, height: 8, color: ORANGE });
    text(`EINBAU  -  Labour Budget  -  generated ${generated}`, M, y - 2, { size: 8, color: MUTED });
    y -= 20;
  }

  // ---- header (first page only — repeat pages just get the thin running header above)
  page.drawRectangle({ x: 0, y: PAGE_H - 8, width: PAGE_W, height: 8, color: ORANGE });
  text("Labour Budget", M, y - 16, { size: 18, f: bold });
  text(`generated ${generated}`, PAGE_W - M - 110, y - 14, { size: 8, color: MUTED });
  y -= 38;

  const facts = [
    ["Project", [data.project.project_number, data.project.name].filter(Boolean).join("  -  ") || "-"],
    ["Customer", data.project.customer || "-"],
    ["PO number", data.project.po_number || "-"],
    ["Based on estimate", data.proposal ? `${data.proposal.name}${data.proposal.quote_nr ? `  (quote ${data.proposal.quote_nr})` : ""}` : "-"],
  ];
  const colW = (PAGE_W - 2 * M) / 2;
  facts.forEach(([k, v], i) => {
    const cx = M + (i % 2) * colW;
    const cy = y - Math.floor(i / 2) * 15;
    text(k, cx, cy, { size: 8, color: MUTED });
    text(wrap(v, font, 9, colW - 110)[0], cx + 100, cy, { size: 9 });
  });
  y -= Math.ceil(facts.length / 2) * 15 + 16;

  text("No dollar figures — hours shown are rounded DOWN to the nearest 15 minutes.", M, y, { size: 7.5, color: MUTED });
  y -= 16;

  const drawColumnHead = () => {
    page.drawRectangle({ x: x0, y: y - 15, width: tableW, height: 17, color: HEAD_BG });
    let cx = x0;
    for (const c of COLS) {
      const tx = c.right ? cx + c.w - 4 - bold.widthOfTextAtSize(c.h, 8) : cx + 4;
      text(c.h, tx, y - 10, { size: 8, f: bold });
      cx += c.w;
    }
    y -= 19;
  };

  const drawGroupHead = (label) => {
    page.drawRectangle({ x: x0, y: y - 16, width: tableW, height: 18, color: GROUP_BG });
    text(label, x0 + 4, y - 11, { size: 9, f: bold });
    y -= 20;
    drawColumnHead();
  };

  let totalRows = 0;
  for (const group of data.groups) {
    const label = group.sub_job || "General";
    if (y - 55 < M) newPage(); // a group header + at least one row needs headroom
    drawGroupHead(label);

    group.items.forEach((item) => {
      const cells = {
        description: item.description,
        budget_code: item.budget_code,
        quantity: String(item.quantity),
        uom: item.uom,
        hours: hoursText(item.hours),
      };
      const wrapped = COLS.map((c) => wrap(cells[c.key], font, 8, c.w - 8));
      const rowH = Math.max(...wrapped.map((w) => w.length)) * 10 + 6;

      if (y - rowH < M + 24) {
        newPage();
        drawGroupHead(`${label}  (cont.)`);
      }

      if (totalRows % 2 === 1) {
        page.drawRectangle({ x: x0, y: y - rowH + 3, width: tableW, height: rowH, color: rgb(0.985, 0.98, 0.97) });
      }
      let cx = x0;
      COLS.forEach((c, ci) => {
        wrapped[ci].forEach((ln, li) => {
          const tx = c.right ? cx + c.w - 4 - font.widthOfTextAtSize(ln, 8) : cx + 4;
          text(ln, tx, y - 7 - li * 10, { size: 8 });
        });
        cx += c.w;
      });
      page.drawLine({ start: { x: x0, y: y - rowH + 3 }, end: { x: x0 + tableW, y: y - rowH + 3 }, thickness: 0.4, color: RULE });
      y -= rowH;
      totalRows += 1;
    });
    y -= 8; // breathing room between groups
  }

  return doc.save();
}
