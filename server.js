import express from "express";
import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

async function getAccessToken() {
  const url = "https://test.api.amadeus.com/v1/security/oauth2/token";

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: process.env.AMADEUS_API_KEY,
    client_secret: process.env.AMADEUS_API_SECRET,
  });

  const res = await axios.post(url, body, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });

  return res.data;
}

// ---------- helpers ----------
function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetweenInclusive(from, to) {
  const d1 = new Date(from);
  const d2 = new Date(to);
  const diff = Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
  return diff + 1;
}

function getStops(offer) {
  const segments = offer.itineraries?.[0]?.segments || [];
  return Math.max(0, segments.length - 1);
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function isPast(dateStr) {
  return dateStr < todayISO();
}

function maxDate(a, b) {
  return a > b ? a : b;
}

function simplifyOffer(offer, searchDate) {
  const firstIt = offer.itineraries?.[0];
  const segments = firstIt?.segments || [];
  const firstSeg = segments[0];
  const lastSeg = segments[segments.length - 1];

  return {
    date: searchDate,
    price: Number(offer.price?.total),
    currency: offer.price?.currency,
    stops: Math.max(0, segments.length - 1),
    duration: firstIt?.duration,
    from: firstSeg?.departure?.iataCode,
    to: lastSeg?.arrival?.iataCode,
    departAt: firstSeg?.departure?.at,
    arriveAt: lastSeg?.arrival?.at,
    carrier: firstSeg?.carrierCode,
    flightNumber: firstSeg ? `${firstSeg.carrierCode}${firstSeg.number}` : null,
    source: offer.source,
    validatingAirlineCodes: offer.validatingAirlineCodes || [],
    lastTicketingDate: offer.lastTicketingDate || null,
  };
}

// ---------- cancelados (cache + strict + operating fix) ----------
const flightStatusCache = new Map();

function normalizeFlightNumber(n) {
  return String(n ?? "").replace(/\D/g, "");
}

/**
 * true  -> cancelado
 * false -> NO cancelado (confirmado)
 * null  -> no determinable
 *
 * Si strict=true y no determinable => se trata como cancelado (filtra).
 */
async function isCancelledFlight({
  token,
  carrierCode,
  flightNumber,
  scheduledDepartureDate,
  strict = true,
}) {
  const fn = normalizeFlightNumber(flightNumber);
  const key = `${carrierCode}-${fn}-${scheduledDepartureDate}-strict:${strict}`;
  if (flightStatusCache.has(key)) return flightStatusCache.get(key);

  if (!carrierCode || !fn || !scheduledDepartureDate) {
    const val = null;
    flightStatusCache.set(key, val);
    return val;
  }

  const today = todayISO();
  if (scheduledDepartureDate < today) {
    const val = null;
    flightStatusCache.set(key, val);
    return val;
  }

  try {
    const resp = await axios.get("https://test.api.amadeus.com/v2/schedule/flights", {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        carrierCode,
        flightNumber: fn,
        scheduledDepartureDate,
      },
    });

    const data = resp.data?.data;
    if (!Array.isArray(data) || data.length === 0) {
      const val = null;
      flightStatusCache.set(key, val);
      return val;
    }

    const statuses = [];
    for (const item of data) {
      if (item?.flightStatus) statuses.push(item.flightStatus);
      if (item?.status) statuses.push(item.status);
      const seg0 = item?.segments?.[0];
      if (seg0?.flightStatus) statuses.push(seg0.flightStatus);
      if (seg0?.status) statuses.push(seg0.status);
    }

    if (statuses.length === 0) {
      const val = strict ? true : null;
      flightStatusCache.set(key, val);
      return val;
    }

    const statusText = statuses.map((s) => String(s).toUpperCase()).join(" | ");
    const cancelled = ["CANCELLED", "CANCELED", "CNCL"].some((k) => statusText.includes(k));

    const result = cancelled ? true : false;
    flightStatusCache.set(key, result);
    return result;
  } catch {
    const val = strict ? true : null;
    flightStatusCache.set(key, val);
    return val;
  }
}

// ---------- Top list helpers ----------
function insertSorted(arr, item, limit, cmp, dedupeKeyFn) {
  if (!item || !Number.isFinite(item.price)) return arr;

  let idx = arr.findIndex((x) => cmp(item, x) < 0);
  if (idx === -1) idx = arr.length;
  arr.splice(idx, 0, item);

  // dedupe
  if (dedupeKeyFn) {
    const seen = new Set();
    const deduped = [];
    for (const it of arr) {
      const key = dedupeKeyFn(it);
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(it);
    }
    arr = deduped;
  }

  return arr.slice(0, limit);
}

function cmpByPrice(a, b) {
  return a.price - b.price;
}

function makeCmpByCloseness(maxPrice) {
  return (a, b) => {
    const da = a.price - maxPrice;
    const db = b.price - maxPrice;
    if (da !== db) return da - db; // más cerca del máximo
    return a.price - b.price; // empate: más barato
  };
}

function dedupeKey(it) {
  return `${it.date}|${it.flightNumber}|${it.price}`;
}

// ---------- core logic (top N + fallback cercano a maxPrice) ----------
async function computeTopFlights(params, onProgress) {
  const {
    origin,
    destination,
    dateFrom,
    dateTo,
    flexDays = 0,
    adults = 1,
    maxPrice,
    maxStops,
    excludeCancelled = true,
    top = 10,
    strictCancel = true,
  } = params;

  if (!origin || !destination || !dateFrom || !dateTo) {
    return {
      status: 400,
      body: { error: "Debes enviar origin, destination, dateFrom y dateTo" },
    };
  }

  const flex = Number(flexDays) || 0;
  const topLimit = Math.max(1, Math.min(50, Number(top) || 10));

  const hasMaxPrice = maxPrice !== undefined && maxPrice !== null && maxPrice !== "";
  const maxP = hasMaxPrice ? Number(maxPrice) : null;

  let searchFrom = addDays(dateFrom, -flex);
  let searchTo = addDays(dateTo, flex);

  const today = todayISO();
  searchFrom = maxDate(searchFrom, today);

  if (searchTo < searchFrom) {
    return {
      status: 400,
      body: {
        error: "Rango inválido: todas las fechas quedan en el pasado. Elige un rango futuro.",
        searchedRange: { from: searchFrom, to: searchTo },
        today,
      },
    };
  }

  const totalDays = daysBetweenInclusive(searchFrom, searchTo);
  if (totalDays > 90) {
    return {
      status: 400,
      body: {
        error: `Rango demasiado grande (${totalDays} días). Reduce flexDays o el rango base.`,
        searchedRange: { from: searchFrom, to: searchTo },
      },
    };
  }

  const tokenData = await getAccessToken();
  const token = tokenData.access_token;

  let withinTop = [];
  let closestTop = [];

  let checkedDays = 0;
  let offersConsidered = 0;
  let offersRemovedCancelled = 0;
  let offersOverMaxPrice = 0;

  // ✅ nuevos contadores
  let offersInvalidPrice = 0;
  let offersFilteredByStops = 0;
  let offersKeptAfterFilters = 0;

  let currentDate = searchFrom;
  const cmpClosest = hasMaxPrice ? makeCmpByCloseness(maxP) : null;

  while (currentDate <= searchTo) {
    checkedDays += 1;

    if (onProgress) {
      onProgress({ type: "progress", checkedDays, totalDays, currentDate });
    }

    const response = await axios.get("https://test.api.amadeus.com/v2/shopping/flight-offers", {
      headers: { Authorization: `Bearer ${token}` },
      params: {
        originLocationCode: origin,
        destinationLocationCode: destination,
        departureDate: currentDate,
        adults: Number(adults),
        max: 20,
      },
    });

    const offers = response.data?.data || [];

    for (const offer of offers) {
      offersConsidered += 1;

      // filtro escalas
      if (maxStops !== undefined && maxStops !== null && maxStops !== "") {
        const stops = getStops(offer);
        if (stops > Number(maxStops)) {
          offersFilteredByStops += 1; // ✅
          continue;
        }
      }

      // filtro cancelados
      if (Boolean(excludeCancelled)) {
        const segments = offer.itineraries?.[0]?.segments || [];
        let cancelledFound = false;

        for (const seg of segments) {
          // ✅ operating si existe
          const carrierCode = seg.operating?.carrierCode || seg.carrierCode;
          const flightNumber = seg.operating?.number || seg.number;
          const segDate = (seg.departure?.at || "").slice(0, 10) || currentDate;

          if (!carrierCode || !flightNumber) {
            if (Boolean(strictCancel)) {
              cancelledFound = true;
              break;
            }
            continue;
          }

          if (isPast(segDate)) {
            if (Boolean(strictCancel)) {
              cancelledFound = true;
              break;
            }
            continue;
          }

          const cancelled = await isCancelledFlight({
            token,
            carrierCode,
            flightNumber,
            scheduledDepartureDate: segDate,
            strict: Boolean(strictCancel),
          });

          if (cancelled === true) {
            cancelledFound = true;
            break;
          }
        }

        if (cancelledFound) {
          offersRemovedCancelled += 1;
          continue;
        }
      }

      const simplified = simplifyOffer(offer, currentDate);
      if (!Number.isFinite(simplified.price)) {
        offersInvalidPrice += 1; // ✅
        continue;
      }

      offersKeptAfterFilters += 1; // ✅

      if (hasMaxPrice) {
        if (simplified.price <= maxP) {
          withinTop = insertSorted(withinTop, simplified, topLimit, cmpByPrice, dedupeKey);
        } else {
          offersOverMaxPrice += 1;
          closestTop = insertSorted(closestTop, simplified, topLimit, cmpClosest, dedupeKey);
        }

        if (onProgress) {
          const mode = withinTop.length ? "within" : "closest";
          const list = withinTop.length ? withinTop : closestTop;
          onProgress({ type: "top", mode, top: list.slice(0, Math.min(5, list.length)) });
        }
      } else {
        withinTop = insertSorted(withinTop, simplified, topLimit, cmpByPrice, dedupeKey);
        if (onProgress) {
          onProgress({ type: "top", mode: "within", top: withinTop.slice(0, Math.min(5, withinTop.length)) });
        }
      }
    }

    currentDate = addDays(currentDate, 1);
  }

  // Selección final
  const finalMode = hasMaxPrice && withinTop.length === 0 ? "closest" : "within";
  const finalTop = finalMode === "closest" ? closestTop : withinTop;

  // ✅ Fallback automático: si strictCancel fue demasiado agresivo y no salió nada
  if (hasMaxPrice && finalMode === "closest" && finalTop.length === 0 && strictCancel === true) {
    const retry = await computeTopFlights({ ...params, strictCancel: false }, null);

    if (retry?.status === 200 && retry?.body?.mode === "closest" && Array.isArray(retry.body.top) && retry.body.top.length > 0) {
      return {
        status: 200,
        body: {
          ...retry.body,
          note: "Fallback aplicado: strictCancel=false para poder construir el TOP cercano",
        },
      };
    }
  }

  return {
    status: 200,
    body: {
      ok: true,
      searchedRange: { from: searchFrom, to: searchTo },
      checkedDays,
      totalDays,
      offersConsidered,
      offersRemovedCancelled,
      offersInvalidPrice,
      offersFilteredByStops,
      offersKeptAfterFilters,
      ...(hasMaxPrice ? { maxPrice: maxP, offersOverMaxPrice } : {}),
      mode: finalMode,
      top: finalTop,
    },
  };
}

// ---------- mini web ----------
app.get("/", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Buscador de vuelos (mini)</title>
  <style>
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; margin: 24px; }
    .wrap { max-width: 1100px; margin: 0 auto; }
    h1 { margin: 0 0 10px; }
    .muted { color:#666; font-size:12px; margin: 0 0 16px; }
    form { display:grid; grid-template-columns: repeat(8, 1fr); gap:12px; align-items:end; }
    label { font-size:12px; display:block; margin-bottom:6px; color:#444; }
    input, select { width:100%; padding:10px; border:1px solid #ccc; border-radius:10px; }
    .full { grid-column: 1 / -1; }
    button { padding:12px 14px; border:0; border-radius:12px; cursor:pointer; font-weight:600; }
    .card { margin-top: 14px; padding: 14px; border: 1px solid #ddd; border-radius: 14px; }
    pre { background:#f7f7f7; padding:12px; border-radius:12px; overflow:auto; margin-top:12px; }
    .barWrap { width:100%; height:12px; border:1px solid #ddd; border-radius:999px; overflow:hidden; }
    .bar { height:100%; width:0%; background:#0b57d0; transition: width 150ms linear; }
    .small { font-size: 12px; color:#444; margin-top:8px; }
    table { width: 100%; border-collapse: collapse; margin-top: 10px; }
    th, td { border-bottom: 1px solid #eee; padding: 10px; text-align: left; font-size: 14px; }
    th { font-size: 12px; color:#555; text-transform: uppercase; letter-spacing: .04em; }
    .right { text-align: right; }
    .pill { display:inline-block; padding:6px 10px; border:1px solid #ddd; border-radius:999px; font-size:12px; margin-right:8px; margin-top:8px; }
    .warn { border-color: #f0c36d; background: #fff7e0; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Buscador de vuelos (mini)</h1>
    <p class="muted">
      TOP N por precio + barra de progreso. Si no hay ofertas ≤ precio máx, devuelve TOP “más cercano por encima”.
    </p>

    <form id="f">
      <div><label>Origen</label><input name="origin" value="MAD" required /></div>
      <div><label>Destino</label><input name="destination" value="CCS" required /></div>
      <div><label>Desde</label><input name="dateFrom" type="date" required /></div>
      <div><label>Hasta</label><input name="dateTo" type="date" required /></div>
      <div><label>Flex días</label><input name="flexDays" type="number" min="0" value="10" /></div>
      <div><label>Adultos</label><input name="adults" type="number" min="1" value="1" /></div>
      <div><label>TOP N</label><input name="top" type="number" min="1" max="50" value="10" /></div>
      <div><label>Strict cancel</label>
        <select name="strictCancel">
          <option value="true" selected>true</option>
          <option value="false">false</option>
        </select>
      </div>

      <div><label>Precio máx (€)</label><input name="maxPrice" type="number" min="0" value="600" /></div>
      <div><label>Máx escalas</label><input name="maxStops" type="number" min="0" value="1" /></div>
      <div>
        <label>Excluir cancelados</label>
        <select name="excludeCancelled">
          <option value="true" selected>true</option>
          <option value="false">false</option>
        </select>
      </div>

      <div class="full">
        <button type="submit">Buscar</button>
      </div>
    </form>

    <div id="progressCard" class="card" style="display:none;">
      <div class="barWrap"><div id="bar" class="bar"></div></div>
      <div id="ptext" class="small">Preparando…</div>
      <div id="topHint" class="small" style="margin-top:6px;"></div>
    </div>

    <div id="out" class="card" style="display:none;"></div>
    <pre id="raw" style="display:none;"></pre>
  </div>

<script>
  function esc(s){return String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");}

  (function initDates(){
    const from = document.querySelector('input[name="dateFrom"]');
    const to = document.querySelector('input[name="dateTo"]');
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const firstNextMonth = new Date(y, m+1, 1);
    const lastNextMonth = new Date(y, m+2, 0);
    const fmt = d => d.toISOString().slice(0,10);
    from.value = fmt(firstNextMonth);
    to.value = fmt(lastNextMonth);
  })();

  let es = null;

  function setProgress(checked, total, currentDate){
    const pct = total ? Math.round((checked/total)*100) : 0;
    document.getElementById("bar").style.width = pct + "%";
    document.getElementById("ptext").textContent =
      "Día " + checked + " de " + total + " — consultando: " + currentDate + " (" + pct + "%)";
  }

  function renderTopHint(mode, top){
    if(!top || !top.length) return;
    const title = mode === "closest"
      ? "Top provisional (más cercano por encima del precio máx)"
      : "Top provisional (≤ precio máx)";

    const lines = top.slice(0,5).map((x,i) =>
      (i+1) + ") " + esc(x.price) + " " + esc(x.currency) + " — " + esc(x.date) + " (" + esc(x.from) + "→" + esc(x.to) + ")"
    );
    document.getElementById("topHint").innerHTML = "<b>" + esc(title) + ":</b><br>" + lines.join("<br>");
  }

  function renderFinal(data){
    const out = document.getElementById("out");
    const raw = document.getElementById("raw");
    out.style.display = "block";
    raw.style.display = "block";
    raw.textContent = JSON.stringify(data, null, 2);

    const list = data.top || [];
    if(!list.length){
      out.classList.remove("warn");
      out.innerHTML = "No encontré ofertas con esos filtros en el rango.";
      return;
    }

    const isClosest = data.mode === "closest";
    out.classList.toggle("warn", isClosest);

    const headerMsg = isClosest
      ? "No hubo ofertas ≤ precio máx. Mostrando TOP más cercano por encima."
      : "Mostrando TOP de ofertas dentro del precio máx.";

    const pills = \`
      <div class="small"><b>\${esc(headerMsg)}</b></div>
      \${data.note ? '<div class="small"><i>' + esc(data.note) + '</i></div>' : ''}
      <span class="pill"><b>Rango:</b> \${esc(data.searchedRange.from)} → \${esc(data.searchedRange.to)}</span>
      <span class="pill"><b>Días:</b> \${esc(data.checkedDays)}</span>
      <span class="pill"><b>Ofertas:</b> \${esc(data.offersConsidered)}</span>
      <span class="pill"><b>Filtradas canceladas:</b> \${esc(data.offersRemovedCancelled)}</span>
      <span class="pill"><b>Invalid price:</b> \${esc(data.offersInvalidPrice ?? 0)}</span>
      <span class="pill"><b>Stop filtered:</b> \${esc(data.offersFilteredByStops ?? 0)}</span>
      <span class="pill"><b>Kept:</b> \${esc(data.offersKeptAfterFilters ?? 0)}</span>
      \${data.maxPrice ? '<span class="pill"><b>Precio máx:</b> ' + esc(data.maxPrice) + '</span>' : ''}
      \${(data.offersOverMaxPrice !== undefined) ? '<span class="pill"><b>Over max:</b> ' + esc(data.offersOverMaxPrice) + '</span>' : ''}
    \`;

    const rows = list.map((b, idx) => \`
      <tr>
        <td>\${idx+1}</td>
        <td>\${esc(b.date)}</td>
        <td>\${esc(b.from)} → \${esc(b.to)}</td>
        <td>\${esc(b.departAt || "")}</td>
        <td>\${esc(b.arriveAt || "")}</td>
        <td>\${esc(b.stops)}</td>
        <td>\${esc(b.carrier || "")} \${esc(b.flightNumber || "")}</td>
        <td class="right"><b>\${esc(b.price)} \${esc(b.currency)}</b></td>
      </tr>
    \`).join("");

    out.innerHTML = \`
      \${pills}
      <table>
        <thead>
          <tr>
            <th>#</th><th>Fecha</th><th>Ruta</th><th>Salida</th><th>Llegada</th><th>Escalas</th><th>Vuelo</th><th class="right">Precio</th>
          </tr>
        </thead>
        <tbody>\${rows}</tbody>
      </table>
    \`;
  }

  document.getElementById("f").addEventListener("submit", (e) => {
    e.preventDefault();

    const fd = new FormData(e.target);
    const payload = Object.fromEntries(fd.entries());

    payload.flexDays = Number(payload.flexDays || 0);
    payload.adults = Number(payload.adults || 1);
    payload.top = Number(payload.top || 10);
    payload.maxPrice = payload.maxPrice ? Number(payload.maxPrice) : "";
    payload.maxStops = payload.maxStops ? Number(payload.maxStops) : "";
    payload.excludeCancelled = payload.excludeCancelled === "true";
    payload.strictCancel = payload.strictCancel === "true";

    document.getElementById("out").style.display = "none";
    document.getElementById("raw").style.display = "none";
    document.getElementById("progressCard").style.display = "block";
    document.getElementById("bar").style.width = "0%";
    document.getElementById("ptext").textContent = "Conectando…";
    document.getElementById("topHint").textContent = "";

    if (es) es.close();

    const qs = new URLSearchParams({
      origin: payload.origin,
      destination: payload.destination,
      dateFrom: payload.dateFrom,
      dateTo: payload.dateTo,
      flexDays: String(payload.flexDays),
      adults: String(payload.adults),
      top: String(payload.top),
      excludeCancelled: String(payload.excludeCancelled),
      strictCancel: String(payload.strictCancel),
    });

    if (payload.maxPrice !== "") qs.set("maxPrice", String(payload.maxPrice));
    if (payload.maxStops !== "") qs.set("maxStops", String(payload.maxStops));

    es = new EventSource("/cheapest-flight/stream?" + qs.toString());

    es.addEventListener("progress", (ev) => {
      const msg = JSON.parse(ev.data);
      setProgress(msg.checkedDays, msg.totalDays, msg.currentDate);
    });

    es.addEventListener("top", (ev) => {
      const msg = JSON.parse(ev.data);
      renderTopHint(msg.mode, msg.top);
    });

    es.addEventListener("done", (ev) => {
      const msg = JSON.parse(ev.data);
      renderFinal(msg);
      es.close();
    });

    es.addEventListener("error", () => {
      document.getElementById("ptext").textContent = "Error en el stream.";
    });
  });
</script>
</body>
</html>`);
});

// ---------- API JSON ----------
app.post("/cheapest-flight", async (req, res) => {
  try {
    const result = await computeTopFlights(req.body || {});
    res.status(result.status).json(result.body);
  } catch (err) {
    res.status(500).json({
      error: "Error buscando vuelos",
      details: err.response?.data || err.message,
    });
  }
});

// ---------- SSE stream ----------
app.get("/cheapest-flight/stream", async (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const send = (eventName, dataObj) => {
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(dataObj)}\n\n`);
  };

  const params = {
    ...req.query,
    flexDays: req.query.flexDays ? Number(req.query.flexDays) : 0,
    adults: req.query.adults ? Number(req.query.adults) : 1,
    top: req.query.top ? Number(req.query.top) : 10,
    maxPrice: req.query.maxPrice ?? undefined,
    maxStops: req.query.maxStops ?? undefined,
    excludeCancelled: req.query.excludeCancelled ? String(req.query.excludeCancelled) === "true" : true,
    strictCancel: req.query.strictCancel ? String(req.query.strictCancel) === "true" : true,
  };

  let closed = false;
  req.on("close", () => { closed = true; });

  try {
    const result = await computeTopFlights(params, (msg) => {
      if (closed) return;
      if (msg.type === "progress") send("progress", msg);
      if (msg.type === "top") send("top", msg);
    });

    if (!closed) {
      if (result.status !== 200) send("done", { ok: false, ...result.body });
      else send("done", result.body);
      res.end();
    }
  } catch (err) {
    if (!closed) {
      send("done", { ok: false, error: "Error en stream", details: err.response?.data || err.message });
      res.end();
    }
  }
});

app.listen(PORT, () => {
  console.log(`Servidor corriendo en http://localhost:${PORT}`);
});
