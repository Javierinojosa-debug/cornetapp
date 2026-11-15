/* CornetApp — modo "Aprender lista": escucha una lista de reproducción entera,
   la corta en marchas por los silencios, les pone nombre (lista pegada o AudD) y guarda sus huellas. */
(() => {
  const $ = (s) => document.querySelector(s);
  const A = () => window.CornetApp;
  const SR = 16000, BLOQUE = 4000;          // bloques de 0,25 s para medir energía
  const MIN_MARCHA = 75, SILENCIO_BLOQUES = 5; // ≥75 s por marcha; ≥1,25 s de silencio = cambio de pista

  let ctx = null, stream = null, proc = null, fuente = null, wake = null, reloj = null;
  let activo = false, t0 = 0, total = 0;
  let segmento = [], segMuestras = 0, silencioSeguido = 0, enSilencio = true;
  let resto = new Float32Array(0), acumRMS = [], posRes = 0, srIn = 48000;
  let titulos = [], ptr = 0, banda = "";
  const aprendidas = [];
  let cola = Promise.resolve();

  // ---------- interfaz ----------
  const vista = $("#v-aprender"), lista = $("#listaAprendidas"), estado = $("#aprEstado");
  $("#btnAprender").addEventListener("click", () => abrir());
  $("#aprCerrar").addEventListener("click", () => { if (activo && !confirm("¿Parar y salir? Se perderá la marcha en curso.")) return; parar(false); cerrar(); });
  $("#aprEmpezar").addEventListener("click", () => (activo ? parar(true) : empezar()));
  $("#aprSiguiente").addEventListener("click", () => { if (activo) cortar("manual"); });
  $("#aprGuardar").addEventListener("click", guardarTodas);

  function abrir() {
    document.querySelectorAll(".vista").forEach((s) => s.classList.remove("activa"));
    vista.classList.add("activa");
    pintar();
  }
  function cerrar() { vista.classList.remove("activa"); document.querySelector('.tabs button[data-vista="marchas"]').click(); }

  function pintar() {
    const pend = aprendidas.filter((a) => a.estado === "lista" && a.incluir);
    $("#aprGuardar").hidden = !pend.length;
    $("#aprGuardar").textContent = `Guardar ${pend.length} marcha${pend.length === 1 ? "" : "s"}`;
    lista.innerHTML = aprendidas.map((a, i) => `<li class="apr-item ${a.incluir ? "" : "off"}" data-i="${i}">
      <div class="li-txt">
        ${a.estado === "procesando" ? `<b>Procesando marcha ${i + 1}…</b>` : `<input class="apr-titulo" value="${A().esc(a.titulo)}" placeholder="Título de la marcha" ${a.estado === "guardada" ? "disabled" : ""}>`}
        <small>${fmt(a.segundos)}${a.origen ? " · " + A().esc(a.origen) : ""}${a.aviso ? " · " + A().esc(a.aviso) : ""}${a.estado === "guardada" ? " · ✓ guardada" : ""}</small>
      </div>
      ${a.preview ? `<button class="chip ghost apr-play" title="Escuchar">▶</button>` : ""}
      ${a.estado === "lista" ? `<input type="checkbox" class="apr-incluir" ${a.incluir ? "checked" : ""} title="Guardar esta">` : ""}
    </li>`).join("") || `<p class="vacio" style="margin-top:3vh">Aquí irán apareciendo las marchas que aprenda.</p>`;
  }
  lista.addEventListener("input", (e) => { const li = e.target.closest("li"); if (li && e.target.classList.contains("apr-titulo")) aprendidas[+li.dataset.i].titulo = e.target.value; });
  lista.addEventListener("change", (e) => { const li = e.target.closest("li"); if (li && e.target.classList.contains("apr-incluir")) { aprendidas[+li.dataset.i].incluir = e.target.checked; pintar(); } });
  lista.addEventListener("click", (e) => {
    const li = e.target.closest("li"); if (!li || !e.target.classList.contains("apr-play")) return;
    const a = aprendidas[+li.dataset.i]; new Audio(URL.createObjectURL(a.preview)).play().catch(() => {});
  });
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  // ---------- captura ----------
  async function empezar() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !navigator.mediaDevices?.getUserMedia) return A().toast("Este navegador no permite grabar audio.");
    ctx = new AC();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch { ctx.close(); ctx = null; return A().toast("Necesito permiso para usar el micrófono."); }
    await ctx.resume().catch(() => {});
    try { wake = await navigator.wakeLock?.request("screen"); } catch {}
    titulos = $("#aprTitulos").value.split("\n").map((s) => s.replace(/^\s*\d+[.)-]?\s*/, "").trim()).filter(Boolean);
    banda = $("#aprBanda").value.trim();
    ptr = aprendidas.length ? ptr : 0;
    srIn = ctx.sampleRate; posRes = 0; resto = new Float32Array(0);
    segmento = []; segMuestras = 0; silencioSeguido = 0; enSilencio = true; acumRMS = [];
    fuente = ctx.createMediaStreamSource(stream);
    proc = ctx.createScriptProcessor(4096, 1, 1);
    proc.onaudioprocess = (e) => recibir(e.inputBuffer.getChannelData(0));
    fuente.connect(proc); proc.connect(ctx.destination);
    activo = true; t0 = Date.now(); total = 0;
    $("#aprEmpezar").textContent = "Parar"; $("#aprEmpezar").classList.add("ghost");
    $("#aprSiguiente").hidden = false; $("#aprConfig").hidden = true;
    reloj = setInterval(() => {
      const enCurso = segMuestras / SR;
      estado.textContent = `Escuchando ${fmt((Date.now() - t0) / 1000)} · ${enSilencio ? "esperando música…" : `marcha ${aprendidas.length + 1} en curso (${fmt(enCurso)})`}${titulos[ptr] && !enSilencio ? ` · «${titulos[ptr]}»` : ""}`;
    }, 500);
  }

  function parar(guardarUltima) {
    if (!activo) return;
    activo = false;
    if (guardarUltima && segMuestras / SR >= 45) cortar("fin");
    clearInterval(reloj);
    proc?.disconnect(); fuente?.disconnect();
    stream?.getTracks().forEach((t) => t.stop()); stream = null;
    ctx?.close().catch(() => {}); ctx = null;
    wake?.release?.().catch(() => {}); wake = null;
    $("#aprEmpezar").textContent = "Empezar a escuchar"; $("#aprEmpezar").classList.remove("ghost");
    $("#aprSiguiente").hidden = true; $("#aprConfig").hidden = false;
    estado.textContent = aprendidas.length ? "Revisa los títulos y pulsa Guardar." : "";
  }

  // Remuestreo al vuelo a 16 kHz (media por cajas) + detección de silencios
  function recibir(d) {
    const r = srIn / SR, x = new Float32Array(resto.length + d.length);
    x.set(resto); x.set(d, resto.length);
    const out = [];
    let p = posRes;
    while (p + r <= x.length) {
      const a = Math.floor(p), b = Math.floor(p + r);
      let s = 0; for (let i = a; i < b; i++) s += x[i];
      out.push(s / Math.max(1, b - a)); p += r;
    }
    const consumido = Math.floor(p);
    resto = x.slice(consumido); posRes = p - consumido;
    const y = Float32Array.from(out);
    total += y.length;
    for (let i = 0; i < y.length; i += BLOQUE) analizarBloque(y.subarray(i, Math.min(y.length, i + BLOQUE)));
  }

  function analizarBloque(b) {
    let s = 0; for (const v of b) s += v * v;
    const rms = Math.sqrt(s / Math.max(1, b.length));
    // umbral relativo al nivel típico de la música reciente
    const ref = acumRMS.length > 20 ? [...acumRMS].sort((a, c) => a - c)[Math.floor(acumRMS.length * 0.5)] : 0.01;
    const callado = rms < Math.max(0.0008, ref * 0.12);
    if (!callado) { acumRMS.push(rms); if (acumRMS.length > 480) acumRMS.shift(); }
    if (callado) {
      silencioSeguido++;
      if (!enSilencio && silencioSeguido >= SILENCIO_BLOQUES) {
        if (segMuestras / SR >= MIN_MARCHA) cortar("silencio");
        else { segmento = []; segMuestras = 0; }   // trozo corto (anuncio, aplausos): se descarta
        enSilencio = true;
      }
      if (!enSilencio) { segmento.push(b.slice()); segMuestras += b.length; }
    } else {
      silencioSeguido = 0;
      if (enSilencio) { enSilencio = false; segmento = []; segMuestras = 0; }
      segmento.push(b.slice()); segMuestras += b.length;
    }
  }

  function cortar(motivo) {
    if (!segMuestras) return;
    const pcm = new Float32Array(segMuestras); let o = 0;
    for (const t of segmento) { pcm.set(t, o); o += t.length; }
    segmento = []; segMuestras = 0;
    if (motivo === "manual") enSilencio = false;
    const item = { estado: "procesando", segundos: pcm.length / SR, titulo: "", incluir: true };
    item.tituloLista = titulos[ptr++] || "";
    aprendidas.push(item); pintar();
    cola = cola.then(() => procesar(item, pcm)).catch((e) => { item.estado = "lista"; item.aviso = "error: " + e.message; pintar(); });
  }

  // ---------- procesado de cada marcha ----------
  const trozo = (pcm, ini, seg) => { const a = Math.max(0, Math.floor(ini * SR)); return pcm.slice(a, Math.min(pcm.length, a + seg * SR)); };
  function normaliza(x) { let p = 0; for (const v of x) p = Math.max(p, Math.abs(v)); const g = p ? Math.min(20, 0.9 / p) : 1; return x.map((v) => v * g); }

  async function procesar(item, pcmBruto) {
    await new Promise((r) => setTimeout(r, 50));
    const pcm = normaliza(pcmBruto), dur = pcm.length / SR;
    const medio = trozo(pcm, dur * 0.4, 20);
    item.preview = A().wavDe(trozo(pcm, dur * 0.4, 8));

    // ¿ya estaba en la base?
    const base = await A().cargarBase();
    if (base?.marchas.length) {
      const q = Huellas.analizar(medio, true), d = Huellas.decidir(Huellas.buscar(base, q), q.hashes.length, q.segundos);
      if (d && d.metodo === "acustica") { item.aviso = `ya estaba: ${d.titulo}`; item.incluir = false; }
    }
    // nombre: lista pegada > AudD > sin nombre
    let sugerencia = "";
    try {
      const r = await fetch("/api/identify", { method: "POST", headers: { "content-type": "audio/wav" }, body: A().wavDe(trozo(pcm, dur * 0.4, 15)) });
      const j = await r.json();
      if (j.ok && j.match) { sugerencia = j.match.title; if (!banda && j.match.artist) item.banda = j.match.artist; }
    } catch {}
    item.titulo = item.tituloLista || sugerencia || `Marcha sin nombre ${aprendidas.indexOf(item) + 1}`;
    item.origen = item.tituloLista ? (sugerencia && sugerencia.toLowerCase() !== item.tituloLista.toLowerCase() ? `de tu lista (AudD dice: ${sugerencia})` : "de tu lista") : sugerencia ? "nombre de AudD" : "ponle nombre";
    item.banda = banda || item.banda || "";

    // huellas completas (mismo formato que el catálogo publicado)
    const a = Huellas.analizar(pcm, false);
    item.huella = { hashes: Array.from(a.hashes), croma: Huellas.cromaATexto(a.croma), segundos: Math.round(a.segundos) };
    item.estado = "lista";
    pintar();
  }

  async function guardarTodas() {
    const pend = aprendidas.filter((a) => a.estado === "lista" && a.incluir);
    let ok = 0;
    $("#aprGuardar").disabled = true;
    for (const a of pend) {
      if (!a.titulo.trim()) { A().toast("Hay marchas sin título"); continue; }
      try {
        const r = await fetch("/api/huellas", { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ titulo: a.titulo.trim(), banda: a.banda || "", ...a.huella }) });
        const j = await r.json();
        if (j.ok) { a.estado = "guardada"; a.incluir = false; ok++; } else a.aviso = j.error;
      } catch (e) { a.aviso = "sin conexión"; }
      pintar();
    }
    $("#aprGuardar").disabled = false;
    await A().cargarBase(true);
    A().toast(`${ok} marcha${ok === 1 ? "" : "s"} guardada${ok === 1 ? "" : "s"}: ya se pueden reconocer`);
  }

  // Para pruebas automáticas
  window.__aprender = { recibir: (d, sr) => { srIn = sr; recibir(d); }, cortar, aprendidas, pintar, simularInicio: (t, b) => { titulos = t; banda = b || ""; ptr = 0; activo = true; srIn = 16000; } };
})();
