console.log("app.js loaded ✅", new Date().toISOString());

const API = "http://127.0.0.1:8000";
console.log('app.js loaded ✅ COLORFIX v3');

// ให้หัวกราฟตรงกับฝั่ง GEE
const PERIOD_SUFFIX = " (2018–2025)";

const provEl = document.getElementById("province");
const leftLayerEl = document.getElementById("leftLayer");
const rightLayerEl = document.getElementById("rightLayer");
const outEl = document.getElementById("out");

// ✅ Fix Leaflet default marker icon broken paths (common with CDN + local server)
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

const map = L.map("map", { zoomControl: true }).setView([14.25, 101.2], 10);

// base map
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);

// ✅ แยก pane ให้ layer ซ้าย/ขวา คนละ container (สำคัญมาก)
map.createPane("leftPane");
map.getPane("leftPane").style.zIndex = 400;

map.createPane("rightPane");
map.getPane("rightPane").style.zIndex = 401;

let leftEE = null;
let rightEE = null;
let sideBySideCtrl = null;

let leftChart = null;
let rightChart = null;

let clickMarker = null; // ✅ marker สำหรับ click popup

// ===== Class label helpers =====
const IND_CLASS_LABEL = { 1: "Degraded", 2: "Improved", 3: "Stable" };
const LDN_CLASS_LABEL = { 0: "Stable", 1: "Improved", 2: "Slightly degraded", 3: "Moderately degraded", 4: "Severely degraded" };
const LDN_CLASS_COLOR = {
  0: "#4def8e",
  1: "#32cd32",
  2: "#FA8072",
  3: "#FF0000",
  4: "#800000",
};
const IND_CLASS_COLOR = { 1: "#d7191c", 2: "#1a9641", 3: "#fdd835" };

function classLabel(val, map) {
  if (val == null) return "—";
  const cls = Math.round(Number(val));
  return map[cls] ?? `Class ${cls}`;
}

function classColor(val, map) {
  if (val == null) return "#9e9e9e";
  const cls = Math.round(Number(val));
  return map[cls] ?? "#9e9e9e";
}

function buildPopupHTML(lat, lng, data) {
  const fmt = (n) => Number(n).toFixed(6);

  // ── indicator rows ──
  const indicators = [
    { key: "luc", label: "LUC" },
    { key: "soc", label: "SOC" },
    { key: "npp", label: "NPP" },
  ];

  const indRows = indicators.map(({ key, label }) => {
    const raw = data?.values?.[key];
    const classVal = raw?.class ?? raw?.b1 ?? null;
    const lbl = classLabel(classVal, IND_CLASS_LABEL);
    const col = classColor(classVal, IND_CLASS_COLOR);
    return `
      <tr>
        <td class="pi-key">${label}</td>
        <td><span class="pi-badge" style="background:${col}">${lbl}</span></td>
      </tr>`;
  }).join("");

  // ── LDN row ──
  const ldnRaw = data?.values?.ldn;
  const ldnClassVal = ldnRaw?.class ?? ldnRaw?.b1 ?? null;
  const ldnLbl = classLabel(ldnClassVal, LDN_CLASS_LABEL);
  const ldnCol = classColor(ldnClassVal, LDN_CLASS_COLOR);

  // One-out / All-out: LDN is "One-out All-out" — degraded if ANY indicator is degraded (class=1)
  const indClasses = indicators.map(({ key }) => {
    const raw = data?.values?.[key];
    return raw?.class ?? raw?.b1 ?? null;
  });
  const anyDegraded = indClasses.some(v => v != null && Math.round(Number(v)) === 1);
  const allDegraded = indClasses.every(v => v != null && Math.round(Number(v)) === 1);
  const oneOutStatus = anyDegraded ? "Degraded (One-out)" : "Not degraded";
  const allOutStatus = allDegraded ? "Degraded (All-out)" : "Not degraded";
  const oneOutCol = anyDegraded ? "#d7191c" : "#1a9641";
  const allOutCol = allDegraded ? "#d7191c" : "#1a9641";

  return `
    <div class="pi-popup">
      <div class="pi-header">📍 Point Info</div>
      <table class="pi-table">
        <tr>
          <td class="pi-key">Latitude</td>
          <td class="pi-val">${fmt(lat)}</td>
        </tr>
        <tr>
          <td class="pi-key">Longitude</td>
          <td class="pi-val">${fmt(lng)}</td>
        </tr>
        <tr><td colspan="2" class="pi-divider">── Indicators ──</td></tr>
        ${indRows}
        <tr><td colspan="2" class="pi-divider">── LDN Status ──</td></tr>
        <tr>
          <td class="pi-key">LDN (final)</td>
          <td><span class="pi-badge" style="background:${ldnCol}">${ldnLbl}</span></td>
        </tr>
      </table>
    </div>`;
}

// ✅ Map click → query /sample → show popup
map.on("click", async (e) => {
  const { lat, lng } = e.latlng;
  const province = provEl.value;

  // Remove previous marker
  if (clickMarker) { map.removeLayer(clickMarker); clickMarker = null; }

  // Show a loading marker immediately
  clickMarker = L.marker([lat, lng]).addTo(map);
  clickMarker.bindPopup(
    `<div class="pi-popup"><div class="pi-header">📍 Loading…</div><div style="padding:6px 10px;font-size:12px;color:#888">Querying GEE…</div></div>`,
    { maxWidth: 280 }
  ).openPopup();

  try {
    const url = `${API}/sample?province=${encodeURIComponent(province)}&lon=${lng}&lat=${lat}`;
    const res = await fetch(url);
    const data = await res.json();

    if (!res.ok) throw new Error(data?.detail || "sample error");

    let html;
    if (!data.in_roi) {
      html = `<div class="pi-popup"><div class="pi-header">📍 Outside ROI</div>
        <div style="padding:6px 10px;font-size:12px;color:#888">This point is outside the selected province boundary.</div></div>`;
    } else {
      html = buildPopupHTML(lat, lng, data);
    }

    clickMarker.setPopupContent(html);
    clickMarker.openPopup();
  } catch (err) {
    clickMarker.setPopupContent(
      `<div class="pi-popup"><div class="pi-header" style="background:#c0392b">⚠ Error</div>
       <div style="padding:6px 10px;font-size:12px;color:#c0392b">${err.message}</div></div>`
    );
    clickMarker.openPopup();
    console.error("sample error", err);
  }
});

async function fetchSummary(province, layer) {
  const url = `${API}/summary?province=${encodeURIComponent(province)}&layer=${encodeURIComponent(layer)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(data?.detail || "summary error");
  return data;
}

// ✅ รองรับหลายรูปแบบ JSON จาก backend
// - {labels:[..], values:[..]}
// - {histogram:{"0":123, "1":456}}
// - {"0":123, "1":456}
function normalizeSummaryToSeries(data, layer) {
  // 1) labels/values อยู่แล้ว
  if (Array.isArray(data?.labels) && Array.isArray(data?.values)) {
    return { labels: data.labels, values: data.values };
  }

  // 2) ดึง histogram object ออกมา (หลายชื่อที่ backend อาจใช้)
  let hist =
    (data && typeof data === "object" && (data.histogram || data.hist || data.counts))
      ? (data.histogram || data.hist || data.counts)
      : data;

  if (!hist || typeof hist !== "object") return { labels: [], values: [] };

  // ✅ เคสที่เจอบ่อย: { b1: { "0":123, "1":456 } } หรือ { b1: { histogram:{...} } }
  // ถ้าเป็น object ที่มี key เดียว (เช่น b1) แล้วข้างในเป็น object ให้ unwrap ลงไป
  const topKeys = Object.keys(hist);
  if (topKeys.length === 1 && hist[topKeys[0]] && typeof hist[topKeys[0]] === "object" && !Array.isArray(hist[topKeys[0]])) {
    hist = hist[topKeys[0]];
    if (hist.histogram || hist.hist || hist.counts) hist = (hist.histogram || hist.hist || hist.counts);
  }

  if (!hist || typeof hist !== "object") return { labels: [], values: [] };

  // ✅ เอาเฉพาะ key ที่เป็นตัวเลขจริง ๆ (กันเคสหลุดเป็น "b1" แล้ว NaN)
  let keys = Object.keys(hist)
    .filter(k => Number.isFinite(Number(k)))
    .sort((a, b) => Number(a) - Number(b));

  // ถ้าไม่มี numeric keys จริง ๆ ค่อย fallback เป็น keys ปกติ (กัน data แปลก)
  if (keys.length === 0) {
    keys = Object.keys(hist).sort();
  }

  const values = keys.map(k => {
    const v = hist[k];
    const num = (typeof v === "number") ? v : parseFloat(v);
    return Number.isFinite(num) ? num : 0; // ✅ กัน NaN ไม่ให้แท่งหาย
  });

  // ✅ ทำ label ให้เหมือนใน GEE (เฉพาะกรณี keys เป็นเลข)
  const kset = new Set(keys);

  const indMap012 = { "0": "Degraded", "1": "Improved", "2": "Stable" };
  const indMap123 = { "1": "Degraded", "2": "Improved", "3": "Stable" };

  const ldnMap01234 = { "0": "Severe", "1": "Moderate", "2": "Slight", "3": "Improved", "4": "Stable" };
  const ldnMap12345 = { "1": "Severe", "2": "Moderate", "3": "Slight", "4": "Improved", "5": "Stable" };

  let labelMap = null;
  const allNumeric = keys.every(k => Number.isFinite(Number(k)));

  if (allNumeric) {
    if (layer === "ldn") {
      if (kset.has("0") && kset.has("4")) labelMap = ldnMap01234;
      else if (kset.has("1") && kset.has("5")) labelMap = ldnMap12345;
    } else {
      if (kset.has("0") && kset.has("2")) labelMap = indMap012;
      else if (kset.has("1") && kset.has("3")) labelMap = indMap123;
    }
  }

  const labels = (labelMap && allNumeric) ? keys.map(k => labelMap[k] || k) : keys;
  return { labels, values };
}

// ===== Palettes =====
const PALETTE_LDN_5 = {
  severe: "#800000",
  moderate: "#FF0000",
  slight: "#FA8072",
  improved: "#32cd32",
  stable: "#4def8e",
};

const PALETTE_3 = {
  degraded: "#d7191c",
  improved: "#1a9641",
  stable: "#fdd835",
};

function normalizeKey(lbl) {
  const s = String(lbl ?? "").trim().toLowerCase();

  // สำคัญ: เช็ค severe/moderate/slight ก่อน degraded
  if (s.includes("severe")) return "severe";          // "Severe", "Severely degraded"
  if (s.includes("moderate")) return "moderate";      // "Moderate", "Moderately degraded"
  if (s.includes("slight")) return "slight";          // "Slight", "Slightly degraded"
  if (s.includes("degrad")) return "degraded";        // "Degraded"
  if (s.includes("improv")) return "improved";        // "Improved"
  if (s.includes("stable")) return "stable";          // "Stable"
  return s;
}

function pickBarColors(labels) {
  const keys = (labels || []).map(normalizeKey);

  // เดาว่าเป็นกราฟ LDN 5 คลาส หรือ indicator 3 คลาส
  const isLdn5 =
    keys.some(k => ["severe", "moderate", "slight"].includes(k)) ||
    (labels?.length === 5);

  return keys.map(k => {
    if (isLdn5) return PALETTE_LDN_5[k] || "#9e9e9e";
    return PALETTE_3[k] || "#9e9e9e";
  });
}

function upsertBarChart(canvasId, chartRef, labels, values, title, layer) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) throw new Error(`canvas not found: #${canvasId}`);

  const layerKey = String(layer || '').toLowerCase();
  const keys = (labels || []).map(normalizeKey);
  const isLdn5 =
    (layerKey === 'ldn' || layerKey.includes('ldn')) ||
    keys.some(k => ['severe', 'moderate', 'slight'].includes(k)) ||
    ((labels || []).length === 5);

  const colorAt = (i) => {
    const k = keys[i] || '';
    return isLdn5 ? (PALETTE_LDN_5[k] || '#9e9e9e') : (PALETTE_3[k] || '#9e9e9e');
  };

  const cfg = {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: title,
        data: values,

        backgroundColor: (ctx) => colorAt(ctx.dataIndex),
        borderColor: (ctx) => colorAt(ctx.dataIndex),
        borderWidth: 1,

        // ✅ ทำให้แท่ง “อ้วนขึ้น”
        barThickness: 35,        // ลอง 45–80 ตามที่ชอบ
        maxBarThickness: 70,
        categoryPercentage: 0.9, // กินพื้นที่ของแต่ละหมวดหมู่
        barPercentage: 0.95,     // กินพื้นที่ภายในหมวดหมู่

        // ✅ ทำให้ดูสวยขึ้น (ไม่จำเป็น แต่ช่วย)
        // borderRadius: 6,
        borderSkipped: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,

      // ✅ เผื่อขอบ chart area เล็กน้อย (ช่วยให้ดูไม่แบน)
      layout: { padding: { left: 8, right: 8, top: 6, bottom: 6 } },

      plugins: {
        legend: {
          position: "top",
          labels: {
            boxWidth: 10,     // ลอง 8–14
            boxHeight: 10,    // ลอง 8–14
            padding: 10,      // ระยะห่างระหว่าง item
            font: { size: 11 },
            // ✅ ทำ legend ให้เป็นราย “คลาส” ตาม labels ของแกน X
            generateLabels: (chart) => {
              const lbls = chart.data.labels || [];
              return lbls.map((text, i) => {
                const c = colorAt(i); // ใช้สีเดียวกับแท่ง
                return {
                  text,
                  fillStyle: c,
                  strokeStyle: c,
                  lineWidth: 1,
                  hidden: false,
                  // ต้องมี index/id เพื่อให้ Chart.js ใช้งานได้ปกติ
                  index: i,
                };
              });
            }
          },
          // ✅ ไม่ต้องให้คลิกแล้วซ่อนแท่ง (กันงง) — จะเอาออกก็ได้
          onClick: () => { }
        },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const v = Number(ctx.parsed.y || 0);
              return `${ctx.label}: ${v.toLocaleString(undefined, { maximumFractionDigits: 2 })} rai`;
            }
          }
        }
      },

      scales: {
        x: {
          // ✅ ช่วยให้แท่งดูเต็มพื้นที่มากขึ้น
          offset: true,
          grid: { display: false },
          ticks: { autoSkip: false, maxRotation: 25, minRotation: 0 }
        },
        y: {
          beginAtZero: true,
          title: { display: true, text: "Area (rai)" },
          ticks: {
            callback: (val) => {
              const n = Number(val);
              return Number.isFinite(n)
                ? n.toLocaleString(undefined, { maximumFractionDigits: 2 })
                : val;
            }
          }
        }
      },
    },
  };

  if (chartRef) {
    chartRef.data = cfg.data;
    chartRef.options = cfg.options;
    chartRef.update();
    return chartRef;
  }
  return new Chart(canvas, cfg);
}

async function refreshCharts() {
  const p = provEl.value;
  const leftLayer = leftLayerEl.value;
  const rightLayer = rightLayerEl.value;

  const leftTitle = document.getElementById("leftChartTitle");
  const rightTitle = document.getElementById("rightChartTitle");
  if (!leftTitle || !rightTitle) throw new Error("chart title elements not found");

  leftTitle.textContent = `${leftLayer.toUpperCase()} - ${p}${PERIOD_SUFFIX}`;
  rightTitle.textContent = (rightLayer === 'ldn')
    ? `LDN Status - ${p}${PERIOD_SUFFIX}`
    : `${rightLayer.toUpperCase()} - ${p}${PERIOD_SUFFIX}`;

  const leftRaw = await fetchSummary(p, leftLayer);
  const rightRaw = await fetchSummary(p, rightLayer);

  const left = normalizeSummaryToSeries(leftRaw, leftLayer);
  const right = normalizeSummaryToSeries(rightRaw, rightLayer);

  leftChart = upsertBarChart("leftChart", leftChart, left.labels, left.values, "Area", leftLayer);
  rightChart = upsertBarChart("rightChart", rightChart, right.labels, right.values, "Area", rightLayer);
}

async function fetchTileUrl(province, layer) {
  const url = `${API}/tiles?province=${encodeURIComponent(province)}&layer=${encodeURIComponent(layer)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(data?.detail || "tiles error");
  return data.urlFormat;
}

async function setEeLayer(side, province, layer) {
  const urlFormat = await fetchTileUrl(province, layer);

  const tile = L.tileLayer(urlFormat, {
    maxZoom: 19,
    opacity: 0.9,
    pane: side === "left" ? "leftPane" : "rightPane",
    interactive: false
  });

  if (side === "left") {
    if (leftEE) map.removeLayer(leftEE);
    leftEE = tile.addTo(map);
  } else {
    if (rightEE) map.removeLayer(rightEE);
    rightEE = tile.addTo(map);
  }
}

function refreshSideBySideControl() {
  if (!leftEE || !rightEE) return;

  if (!L.control || typeof L.control.sideBySide !== "function") {
    console.warn("leaflet-side-by-side plugin not loaded");
    return; // ✅ ไม่พังทั้ง refresh()
  }

  if (sideBySideCtrl) {
    map.removeControl(sideBySideCtrl);
    sideBySideCtrl = null;
  }

  sideBySideCtrl = L.control.sideBySide(leftEE, rightEE).addTo(map);
  setTimeout(() => map.invalidateSize(), 0);
}

async function refresh() {
  try {
    const p = provEl.value;
    const l = leftLayerEl.value;
    const r = rightLayerEl.value;

    await setEeLayer("left", p, l);
    await setEeLayer("right", p, r);

    refreshSideBySideControl();
    await refreshCharts();

    outEl.textContent = `Loaded: ${p} | left=${l} | right=${r}`;
  } catch (e) {
    outEl.textContent = "ERROR: " + e.message;
    console.error(e);
  }
}

document.getElementById("btnSummary").onclick = async () => {
  try {
    const p = provEl.value;
    const layer = leftLayerEl.value;
    const data = await fetchSummary(p, layer);
    outEl.textContent = JSON.stringify(data, null, 2);
  } catch (e) {
    outEl.textContent = "ERROR(summary): " + e.message;
  }
};

provEl.onchange = refresh;
leftLayerEl.onchange = refresh;
rightLayerEl.onchange = refresh;

window.addEventListener("resize", () => {
  if (map) map.invalidateSize();
});

refresh();