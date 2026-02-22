console.log("app.js loaded ✅", new Date().toISOString());

const API = "http://127.0.0.1:8000";
console.log('app.js loaded ✅ COLORFIX v3');

// ให้หัวกราฟตรงกับฝั่ง GEE
const PERIOD_SUFFIX = " (2018–2025)";

const provEl = document.getElementById("province");
const leftLayerEl = document.getElementById("leftLayer");
const rightLayerEl = document.getElementById("rightLayer");
// const outEl = document.getElementById("out");

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
let lastProvince = null;
let lastLeftLayer = null;
let lastRightLayer = null;

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
  if (document.body.classList.contains("show-charts") ||
    document.body.classList.contains("show-legend")) {
    return;
  }

  const { lat, lng } = e.latlng;
  const province = provEl.value;

  // ✅ ลบ marker เก่าทันที
  if (clickMarker) {
    map.removeLayer(clickMarker);
    clickMarker = null;
  }

  // ✅ สร้าง marker ทันที (ไม่รอ fetch)
  clickMarker = L.marker([lat, lng]).addTo(map);
  const currentZoom = map.getZoom();
  const targetZoom = currentZoom < 12 ? 12 : currentZoom;

  map.flyTo([lat, lng], targetZoom, {
    animate: true,
    duration: 0.6
  });

  // ✅ popup loading ก่อน
  clickMarker.bindPopup(`
    <div class="pi-popup">
      <div class="pi-header">📍 Loading…</div>
      <div style="padding:6px 10px;font-size:12px;color:#888">
        Querying GEE…
      </div>
    </div>
  `, { maxWidth: 280 }).openPopup();

  try {
    const url = `${API}/sample?province=${encodeURIComponent(province)}&lon=${lng}&lat=${lat}`;
    const res = await fetch(url);
    const data = await res.json();

    if (!res.ok) throw new Error(data?.detail || "sample error");

    // ถ้าอยู่นอก ROI
    if (!data.in_roi) {
      clickMarker.setPopupContent(`
        <div class="pi-popup">
          <div class="pi-header">📍 Outside ROI</div>
          <div style="padding:6px 10px;font-size:12px;color:#888">
            This point is outside the selected province boundary.
          </div>
        </div>
      `);
    }

    const html = buildPopupHTML(lat, lng, data);

    // ✅ update popup content แทนการสร้างใหม่
    clickMarker.setPopupContent(html);

  } catch (err) {
    console.error("sample error", err);

    clickMarker.setPopupContent(`
      <div class="pi-popup">
        <div class="pi-header" style="background:#c0392b">
          ⚠ Error
        </div>
        <div style="padding:6px 10px;font-size:12px;color:#c0392b">
          ${err.message}
        </div>
      </div>
    `);
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

  const ldnMap01234 = { "0": "Stable", "1": "Improved", "2": "Slight", "3": "Moderate", "4": "Severe" };
  const ldnMap12345 = { "1": "Stable", "2": "Improved", "3": "Slight", "4": "Moderate", "5": "Severe" };

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


function buildLegendHTML(layer) {
  const l = String(layer).toLowerCase();
  let html = "";

  if (l === "ldn") {
    html += `<div class="map-legend-title">LDN Classes</div>`;
    const items = [
      ["Severely degraded", PALETTE_LDN_5.severe],
      ["Moderately degraded", PALETTE_LDN_5.moderate],
      ["Slightly degraded", PALETTE_LDN_5.slight],
      ["Improved", PALETTE_LDN_5.improved],
      ["Stable", PALETTE_LDN_5.stable],
    ];

    items.forEach(([label, color]) => {
      html += `
        <div class="map-legend-item">
          <div class="map-legend-dot" style="background:${color}"></div>
          <span>${label}</span>
        </div>`;
    });

  } else {
    html += `<div class="map-legend-title">Indicator Classes</div>`;
    const items = [
      ["Degraded", PALETTE_3.degraded],
      ["Improved", PALETTE_3.improved],
      ["Stable", PALETTE_3.stable],
    ];

    items.forEach(([label, color]) => {
      html += `
        <div class="map-legend-item">
          <div class="map-legend-dot" style="background:${color}"></div>
          <span>${label}</span>
        </div>`;
    });
  }

  return html;
}

function updateBothLegends(leftLayer, rightLayer) {
  const leftLegend = document.getElementById("mapLegendLeft");
  const rightLegend = document.getElementById("mapLegendRight");

  if (leftLegend) leftLegend.innerHTML = buildLegendHTML(leftLayer);
  if (rightLegend) rightLegend.innerHTML = buildLegendHTML(rightLayer);
}

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

  // Create gradient fills for bars
  const makeGradient = (ctx, chartArea, baseColor) => {
    if (!chartArea) return baseColor;
    const gradient = ctx.createLinearGradient(0, chartArea.bottom, 0, chartArea.top);
    gradient.addColorStop(0, baseColor + 'cc');
    gradient.addColorStop(1, baseColor);
    return gradient;
  };

  const cfg = {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: title,
        data: values,

        backgroundColor: (ctx) => {
          const chart = ctx.chart;
          const { chartArea } = chart;
          return makeGradient(chart.ctx, chartArea, colorAt(ctx.dataIndex));
        },
        borderColor: (ctx) => colorAt(ctx.dataIndex),
        borderWidth: 0,

        barThickness: 'flex',
        maxBarThickness: 60,
        categoryPercentage: 0.75,
        barPercentage: 0.85,
        borderRadius: 6,
        borderSkipped: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 800,
        easing: 'easeOutQuart',
      },

      layout: { padding: { left: 4, right: 4, top: 8, bottom: 4 } },

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
          backgroundColor: 'rgba(17, 24, 39, 0.92)',
          titleFont: { size: 12, weight: '600', family: 'Inter' },
          bodyFont: { size: 12, family: 'Inter' },
          padding: { top: 8, bottom: 8, left: 12, right: 12 },
          cornerRadius: 8,
          displayColors: true,
          boxWidth: 10,
          boxHeight: 10,
          boxPadding: 4,
          usePointStyle: true,
          callbacks: {
            title: (items) => items[0]?.label || '',
            label: (ctx) => {
              const v = Number(ctx.parsed.y || 0);
              return ` ${v.toLocaleString(undefined, { maximumFractionDigits: 2 })} rai`;
            }
          }
        }
      },

      scales: {
        x: {
          offset: true,
          grid: { display: false },
          border: { display: false },
          ticks: {
            autoSkip: false,
            maxRotation: 30,
            minRotation: 0,
            font: { size: 11, weight: '500', family: 'Inter' },
            color: '#6b7280',
          }
        },
        y: {
          beginAtZero: true,
          border: { display: false },
          grid: {
            color: 'rgba(0, 0, 0, 0.06)',
            drawTicks: false,
          },
          ticks: {
            padding: 8,
            font: { size: 10, family: 'Inter' },
            color: '#9ca3af',
            callback: (val) => {
              const n = Number(val);
              if (!Number.isFinite(n)) return val;
              if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
              if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
              return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
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

  leftTitle.textContent = `${leftLayer.toUpperCase()} - ${p}${PERIOD_SUFFIX}`;
  rightTitle.textContent = (rightLayer === 'ldn')
    ? `LDN Status - ${p}${PERIOD_SUFFIX}`
    : `${rightLayer.toUpperCase()} - ${p}${PERIOD_SUFFIX}`;

  const provinceChanged = p !== lastProvince;
  const leftChanged = leftLayer !== lastLeftLayer;
  const rightChanged = rightLayer !== lastRightLayer;

  // ✅ ถ้าเปลี่ยนจังหวัด → โหลดทั้งสองฝั่ง
  if (provinceChanged) {
    const [leftRaw, rightRaw] = await Promise.all([
      fetchSummary(p, leftLayer),
      fetchSummary(p, rightLayer)
    ]);

    const leftAreaInfo = document.getElementById("leftAreaInfo");
    const rightAreaInfo = document.getElementById("rightAreaInfo");

    const provinceArea =
      leftRaw?.province_area ||
      rightRaw?.province_area ||
      null;

    if (provinceArea && leftAreaInfo && rightAreaInfo) {
      const formatted = Number(provinceArea).toLocaleString(undefined, {
        maximumFractionDigits: 2,
      });

      leftAreaInfo.textContent = `Province area: ${formatted} rai`;
      rightAreaInfo.textContent = `Province area: ${formatted} rai`;
    }

    const left = normalizeSummaryToSeries(leftRaw, leftLayer);
    const right = normalizeSummaryToSeries(rightRaw, rightLayer);

    leftChart = upsertBarChart("leftChart", leftChart, left.labels, left.values, "Area", leftLayer);
    rightChart = upsertBarChart("rightChart", rightChart, right.labels, right.values, "Area", rightLayer);
  }
  else {
    // ✅ โหลดเฉพาะฝั่งที่เปลี่ยน
    if (leftChanged) {
      const leftRaw = await fetchSummary(p, leftLayer);
      const left = normalizeSummaryToSeries(leftRaw, leftLayer);
      leftChart = upsertBarChart("leftChart", leftChart, left.labels, left.values, "Area", leftLayer);
    }

    if (rightChanged) {
      const rightRaw = await fetchSummary(p, rightLayer);
      const right = normalizeSummaryToSeries(rightRaw, rightLayer);
      rightChart = upsertBarChart("rightChart", rightChart, right.labels, right.values, "Area", rightLayer);
    }
  }

  lastProvince = p;
  lastLeftLayer = leftLayer;
  lastRightLayer = rightLayer;
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

async function zoomToProvince(province) {
  const url = `${API}/bounds?province=${encodeURIComponent(province)}`;
  const res = await fetch(url);
  const data = await res.json();
  if (!res.ok) throw new Error(data?.detail || "bounds error");

  if (data.bounds) {
    map.fitBounds(data.bounds, {
      padding: [20, 20],
      animate: true,
      duration: 0.8
    });
  }
}

async function refresh(shouldZoom = false) {
  try {
    if (shouldZoom && clickMarker) {
      map.removeLayer(clickMarker);
      clickMarker = null;
    }
    const p = provEl.value;
    const l = leftLayerEl.value;
    const r = rightLayerEl.value;

    if (shouldZoom) {
      await zoomToProvince(p);
    }
    await setEeLayer("left", p, l);
    await setEeLayer("right", p, r);

    refreshSideBySideControl();
    await refreshCharts();
    updateBothLegends(l, r);

    outEl.textContent = `Loaded: ${p} | left=${l} | right=${r}`;
  } catch (e) {
    outEl.textContent = "ERROR: " + e.message;
    console.error(e);
  }
}

// document.getElementById("btnSummary").onclick = async () => {
//   try {
//     const p = provEl.value;
//     const layer = leftLayerEl.value;
//     const data = await fetchSummary(p, layer);
//     outEl.textContent = JSON.stringify(data, null, 2);
//   } catch (e) {
//     outEl.textContent = "ERROR(summary): " + e.message;
//   }
// };

provEl.onchange = () => refresh(true);   // เปลี่ยนจังหวัด → zoom
leftLayerEl.onchange = () => refresh(false);  // เปลี่ยน layer → ไม่ zoom
rightLayerEl.onchange = () => refresh(false);

// ===== UI Helpers for Mobile Tabs =====

window.switchTab = function (tabId) {
  // Clear tab states
  document.body.classList.remove('show-charts', 'show-legend');

  if (tabId === 'charts') document.body.classList.add('show-charts');
  if (tabId === 'legend') document.body.classList.add('show-legend');

  // Update nav active state
  document.querySelectorAll('.nav-item')
    .forEach(btn => btn.classList.remove('active'));

  const navId =
    tabId === 'map' ? 'navMap' :
      tabId === 'charts' ? 'navCharts' :
        'navLegend';

  const navBtn = document.getElementById(navId);
  if (navBtn) navBtn.classList.add('active');

  // 🔥 LOCK / UNLOCK LEAFLET MAP PROPERLY
  if (tabId === 'map') {
    map.dragging.enable();
    map.touchZoom.enable();
    map.doubleClickZoom.enable();
    map.scrollWheelZoom.enable();
    map.boxZoom.enable();
    map.keyboard.enable();
    setTimeout(() => map.invalidateSize(), 100);
  } else {
    map.dragging.disable();
    map.touchZoom.disable();
    map.doubleClickZoom.disable();
    map.scrollWheelZoom.disable();
    map.boxZoom.disable();
    map.keyboard.disable();
  }
};

window.addEventListener("resize", () => {
  if (map) map.invalidateSize();
});

refresh(false);

const legendPanel = document.getElementById("mapLegendPanel");
const legendToggleDesktop = document.getElementById("legendToggleDesktop");

window.toggleLegend = function () {
  if (!legendPanel) return;
  const isActive = legendPanel.classList.toggle("active");

  // Toggle active state on the desktop header button
  if (legendToggleDesktop) {
    legendToggleDesktop.classList.toggle("legend-active", isActive);
  }
};

if (legendToggleDesktop) {
  legendToggleDesktop.addEventListener("click", toggleLegend);
}

// Click outside legend panel to close (desktop)
document.addEventListener("click", (e) => {
  if (!legendPanel || !legendPanel.classList.contains("active")) return;

  const clickedInPanel = legendPanel.contains(e.target);
  const clickedToggle = legendToggleDesktop && legendToggleDesktop.contains(e.target);

  if (!clickedInPanel && !clickedToggle) {
    legendPanel.classList.remove("active");
    if (legendToggleDesktop) legendToggleDesktop.classList.remove("legend-active");
  }
});