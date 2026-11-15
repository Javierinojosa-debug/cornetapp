/* CornetApp — app principal */
(() => {
  const $ = (s) => document.querySelector(s);
  const SEGUNDOS = 12;
  const DEMO = new URLSearchParams(location.search).has("demo");
  const K = { hist: "cornetapp.historial", extra: "cornetapp.catalogo", ubic: "cornetapp.ubicacion" };

  // ---------- almacenamiento ----------
  const leer = (k, def) => { try { return JSON.parse(localStorage.getItem(k)) ?? def; } catch { return def; } };
  const guardar = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };

  // ---------- utilidades ----------
  const norm = (s = "") => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/\(.*?\)|\[.*?\]/g, " ").replace(/[^a-z0-9ñ ]/g, " ").replace(/\s+/g, " ").trim();
  const esc = (s = "") => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const slug = (s) => norm(s).replace(/ /g, "-") || "marcha-" + Date.now();
  const fecha = (ts) => new Date(ts).toLocaleString("es-ES", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  let toastT;
  const toast = (m) => { const t = $("#toast"); t.textContent = m; t.classList.add("ver"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("ver"), 2800); };

  // ---------- catálogo ----------
  function catalogo() {
    const extra = leer(K.extra, {});
    const base = (window.CATALOGO_BASE || []).map((m) => extra[m.id] ? { ...m, ...extra[m.id] } : m);
    const nuevas = Object.values(extra).filter((m) => !base.some((b) => b.id === m.id));
    return [...base, ...nuevas].sort((a, b) => a.titulo.localeCompare(b.titulo, "es"));
  }
  function buscarEnCatalogo(titulo) {
    const t = norm(titulo);
    if (!t) return null;
    const cat = catalogo();
    const nombres = (m) => [m.titulo, ...(m.alias || [])].map(norm).filter(Boolean);
    return cat.find((m) => nombres(m).includes(t))
      || cat.find((m) => nombres(m).some((n) => n.length > 4 && (t.includes(n) || n.includes(t))))
      || null;
  }

  // ---------- navegación ----------
  document.querySelectorAll(".tabs button").forEach((b) => b.addEventListener("click", () => irA(b.dataset.vista)));
  function irA(v) {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("activo", b.dataset.vista === v));
    document.querySelectorAll(".vista").forEach((s) => s.classList.toggle("activa", s.id === "v-" + v));
    if (v === "historial") pintarHistorial();
    if (v === "marchas") pintarCatalogo();
  }

  // ---------- grabación ----------
  const wrap = $(".boton-wrap"), arco = $("#arco"), estado = $("#estado"), lema = $("#lema");
  let ultimaGrabacion = null;
  let ocupado = false, stream = null, ctx = null, cancelar = null;

  $("#btnEscuchar").addEventListener("click", () => (ocupado ? cancelar?.() : escuchar()));

  const MAX_SEG = 20, PUNTOS = [6, 9, 12, 15, 18, 20]; // escucha continua: analiza en estos segundos y para al reconocer

  async function escuchar() {
    if (DEMO) return simular();
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC || !navigator.mediaDevices?.getUserMedia) return toast("Este navegador no permite grabar audio.");
    ctx = new AC();                                   // se crea dentro del toque (requisito de Safari)
    const basePromesa = cargarBase();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch {
      ctx.close().catch(() => {}); ctx = null;
      return toast("Necesito permiso para usar el micrófono.");
    }
    await ctx.resume().catch(() => {});
    ocupado = true;
    const posPromesa = pedirUbicacion();
    wrap.classList.add("escuchando");
    lema.textContent = "Escuchando a la banda…";
    estado.textContent = "Mantén el móvil hacia la música";

    // captura de audio sin comprimir + medidor de nivel
    const srIn = ctx.sampleRate, trozos = [];
    let muestras = 0;
    const fuente = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser(); an.fftSize = 512; fuente.connect(an);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    proc.onaudioprocess = (e) => { const d = e.inputBuffer.getChannelData(0); trozos.push(new Float32Array(d)); muestras += d.length; };
    fuente.connect(proc); proc.connect(ctx.destination);   // la salida va en silencio
    const dNivel = new Uint8Array(an.fftSize);
    const tick = () => { if (!ocupado || !ctx) return; an.getByteTimeDomainData(dNivel);
      let s2 = 0; for (const v of dNivel) s2 += ((v - 128) / 128) ** 2;
      wrap.style.setProperty("--nivel", Math.min(1, Math.sqrt(s2 / dNivel.length) * 4).toFixed(2)); requestAnimationFrame(tick); };
    tick();

    let cancelado = false, terminado = false;
    cancelar = () => { cancelado = true; };
    const seg = () => muestras / srIn;
    const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
    let local = null, diagLocal = null, pcm = null;
    const base = await basePromesa;

    for (const p of PUNTOS) {
      while (!cancelado && seg() < p) { arco.style.strokeDashoffset = 654 * (1 - Math.min(1, seg() / MAX_SEG)); await esperar(100); }
      if (cancelado) break;
      pcm = await a16k(trozos, srIn).catch(() => null);
      if (!pcm || !base || !base.marchas.length) continue;
      try {
        const q = Huellas.analizar(pcm, true), res = Huellas.buscar(base, q);
        local = Huellas.decidir(res, q.hashes.length, q.segundos);
        const v = [...res].sort((a, b) => b.votos - a.votos)[0], c = [...res].sort((a, b) => a.coste - b.coste)[0];
        diagLocal = { votos: v.votos, mejorVotos: v.titulo, coste: c.coste.toFixed(3), mejorCoste: c.titulo, marchas: base.marchas.length, umbralCoste: q.segundos >= 18 ? Huellas.UMBRAL.costeLargo : Huellas.UMBRAL.coste };
      } catch (err) { console.warn("huellas", err); }
      if (local) break;
      estado.textContent = p < MAX_SEG ? `Sigo escuchando… (${p} s)` : "";
    }
    terminado = true;
    proc.disconnect(); fuente.disconnect();
    soltarMicro();
    wrap.classList.remove("escuchando");
    arco.style.strokeDashoffset = 654;
    if (cancelado && !local) {
      if (seg() < 5) return reiniciar("Cancelado");
      pcm = await a16k(trozos, srIn).catch(() => null);  // cancelado con audio suficiente: se consulta igualmente
    }
    if (!pcm) return reiniciar("No he podido procesar el audio");

    wrap.classList.add("pensando");
    lema.textContent = "Buscando la marcha…";
    estado.textContent = "";
    const blob = wavDe(pcm), segTxt = (pcm.length / 16000).toFixed(1);
    try {
      const pos = await posPromesa;
      if (local) {
        ultimaGrabacion = { blob, seg: segTxt, diagLocal };
        return resultado({ title: local.titulo, artist: local.banda, fuente: "cornetapp", metodo: local.metodo, confianza: local.confianza, segundo: local.segundo }, pos);
      }
      const r = await fetch("/api/identify", { method: "POST", headers: { "content-type": "audio/wav" }, body: blob });
      const data = await r.json().catch(() => ({ ok: false, error: r.status === 404 ? "El servidor de reconocimiento no está disponible." : "Respuesta no válida." }));
      if (!data.ok) throw new Error(data.error || "Error al reconocer");
      ultimaGrabacion = { blob, seg: segTxt, diag: data.diag, diagLocal };
      resultado(data.match ? { ...data.match, fuente: "audd" } : null, pos);
    } catch (e) {
      toast(e.message);
      reiniciar();
    }
  }

  // Une lo capturado (últimos 20 s), lo pasa a 16 kHz mono y normaliza el volumen
  async function a16k(trozos, srIn) {
    let total = trozos.reduce((n, t) => n + t.length, 0);
    const max = Math.floor(MAX_SEG * srIn), ini = Math.max(0, total - max), len = total - ini;
    const x = new Float32Array(len);
    let pos = 0, salto = ini;
    for (const t of trozos) { if (salto >= t.length) { salto -= t.length; continue; } const parte = t.subarray(salto); salto = 0; x.set(parte, pos); pos += parte.length; }
    const n = Math.ceil((len * 16000) / srIn);
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const off = new OAC(1, n, 16000);
    const buf = off.createBuffer(1, len, srIn); buf.getChannelData(0).set(x);
    const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start();
    const pcm = new Float32Array((await off.startRendering()).getChannelData(0));
    let pico = 0; for (const v of pcm) pico = Math.max(pico, Math.abs(v));
    const g = pico > 0 ? Math.min(20, 0.9 / pico) : 1;
    for (let i = 0; i < pcm.length; i++) pcm[i] *= g;
    return pcm;
  }

  let basePromesa = null;
  function cargarBase() {
    if (!window.Huellas) return Promise.resolve(null);
    return (basePromesa ||= fetch("huellas/base.json?v=" + (window.CORNETAPP_VERSION || 1))
      .then((r) => (r.ok ? r.json() : null)).then((b) => (b ? Huellas.prepararBase(b) : null))
      .catch(() => { basePromesa = null; return null; }));
  }

  // WAV mono 16 kHz: formato que AudD siempre lee bien
  function wavDe(pcm) {
    const SR = 16000, n = pcm.length, dv = new DataView(new ArrayBuffer(44 + n * 2));
    const w = (o, t) => [...t].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
    w(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); w(8, "WAVEfmt "); dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, SR, true); dv.setUint32(28, SR * 2, true);
    dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, "data"); dv.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, pcm[i] * 32767, true);
    return new Blob([dv.buffer], { type: "audio/wav" });
  }

  function soltarMicro() {
    stream?.getTracks().forEach((t) => t.stop()); stream = null;
    ctx?.close().catch(() => {}); ctx = null;
  }
  function reiniciar(msg) {
    ocupado = false; cancelar = null;
    wrap.classList.remove("escuchando", "pensando");
    lema.textContent = "Toca la corneta mientras pasa la banda";
    estado.innerHTML = msg ? esc(msg) : "&nbsp;";
  }

  // ---------- ubicación (opcional) ----------
  const chkU = $("#chkUbicacion");
  chkU.checked = leer(K.ubic, false);
  chkU.addEventListener("change", () => guardar(K.ubic, chkU.checked));
  function pedirUbicacion() {
    if (!chkU.checked || !navigator.geolocation) return Promise.resolve(null);
    return new Promise((res) => navigator.geolocation.getCurrentPosition(
      (p) => res({ lat: +p.coords.latitude.toFixed(5), lon: +p.coords.longitude.toFixed(5) }),
      () => res(null), { enableHighAccuracy: false, timeout: 15000, maximumAge: 120000 }));
  }

  // ---------- resultado ----------
  function resultado(match, pos) {
    reiniciar();
    if (!match) return abrirHoja(htmlNoMatch());
    const entrada = { id: Date.now(), ts: Date.now(), ...match, pos };
    const h = leer(K.hist, []); h.unshift(entrada); guardar(K.hist, h.slice(0, 500));
    abrirHoja(htmlFicha(entrada));
    if (navigator.vibrate) navigator.vibrate([40, 40, 80]);
  }

  function enlacesEscucha(e) {
    const q = encodeURIComponent(`${e.title} ${e.artist || "marcha procesional"}`);
    return `<div class="enlaces">
      ${e.spotify ? `<a class="chip" href="${esc(e.spotify)}" target="_blank" rel="noopener">Spotify</a>` : ""}
      ${e.apple_music ? `<a class="chip" href="${esc(e.apple_music)}" target="_blank" rel="noopener">Apple Music</a>` : ""}
      <a class="chip ${e.spotify || e.apple_music ? "ghost" : ""}" href="https://www.youtube.com/results?search_query=${q}" target="_blank" rel="noopener">YouTube</a>
    </div>`;
  }

  function bloqueCatalogo(m) {
    if (!m) return "";
    const herm = (m.hermandades || []).length
      ? `<ul class="hermandades">${m.hermandades.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : `<span style="color:#a99d88">Sin datos</span>`;
    return `<dl class="datos">
        ${m.compositor ? `<dt>Compositor</dt><dd>${esc(m.compositor)}</dd>` : ""}
        ${m.anio ? `<dt>Año</dt><dd>${esc(m.anio)}</dd>` : ""}
        ${m.tipo ? `<dt>Formación</dt><dd>${esc(m.tipo)}</dd>` : ""}
        <dt>Hermandades</dt><dd>${herm}</dd>
      </dl>${m.nota ? `<p class="nota">${esc(m.nota)}</p>` : ""}`;
  }

  function htmlFicha(e) {
    const m = buscarEnCatalogo(e.title);
    const anioGrab = (e.release_date || "").slice(0, 4);
    return `<div class="asa"></div>
      <div class="ficha-cab">
        ${e.cover ? `<img class="portada" src="${esc(e.cover)}" alt="">` : `<div class="portada"></div>`}
        <div><h3>${esc(e.title)}</h3><p>${esc(e.artist || "Banda desconocida")}</p></div>
      </div>
      ${bloqueCatalogo(m)}
      <dl class="datos" style="margin-top:${m ? 0 : 18}px">
        ${e.album ? `<dt>Disco</dt><dd>${esc(e.album)}${anioGrab ? ` (${anioGrab})` : ""}</dd>` : ""}
        ${e.fuente === "cornetapp" ? `<dt>Fuente</dt><dd>Catálogo CornetApp · ${e.metodo === "melodia" ? "por melodía (posible coincidencia)" : "huella acústica"}${e.segundo && e.metodo !== "melodia" ? ` · minuto ${Math.floor(e.segundo / 60)}:${String(Math.floor(e.segundo % 60)).padStart(2, "0")}` : ""}</dd>` : ""}
        ${e.ts ? `<dt>Reconocida</dt><dd>${fecha(e.ts)}</dd>` : ""}
        ${e.pos ? `<dt>Lugar</dt><dd><a style="color:var(--oro-claro)" href="https://maps.google.com/?q=${e.pos.lat},${e.pos.lon}" target="_blank" rel="noopener">Ver en el mapa</a></dd>` : ""}
      </dl>
      ${enlacesEscucha(e)}
      <div class="enlaces" style="margin-top:14px">
        <button class="chip ghost" data-accion="editar" data-titulo="${esc(e.title)}" data-id="${m ? esc(m.id) : ""}">${m ? "Editar ficha / hermandades" : "Completar ficha"}</button>
      </div>
      ${m ? "" : `<p class="aviso">Esta marcha aún no está en el catálogo de CornetApp. Añade compositor y hermandades y la próxima vez saldrán en la ficha.</p>`}`;
  }

  function htmlNoMatch() {
    return `<div class="asa"></div><div class="no-match">
      <img src="icons/icon.svg" alt="" style="width:64px;border-radius:14px;opacity:.8">
      <h3>No la he reconocido</h3>
      <ul>
        <li>Acércate a la banda y aleja el móvil del ruido de la gente.</li>
        <li>Espera a que la marcha esté en una parte con melodía, no solo tambor.</li>
        <li>Las versiones en directo cuestan más: si esa banda no ha grabado la marcha, puede no estar en la base de datos.</li>
      </ul>
      <button class="chip" data-accion="reintentar">Volver a escuchar</button>
      ${ultimaGrabacion ? `<details style="margin-top:18px;text-align:left;font-size:12.5px;color:#a99d88">
        <summary>Diagnóstico</summary>
        <p>Formato: ${esc(ultimaGrabacion.blob.type || "?")} · ${(ultimaGrabacion.blob.size / 1024).toFixed(0)} KB · ${ultimaGrabacion.seg} s
        ${ultimaGrabacion.diagLocal ? `<br>CornetApp (${ultimaGrabacion.diagLocal.marchas} marchas): ${ultimaGrabacion.diagLocal.votos} votos acústicos con «${esc(ultimaGrabacion.diagLocal.mejorVotos)}» (mín. ${Huellas.UMBRAL.votos}), distancia de melodía ${ultimaGrabacion.diagLocal.coste} con «${esc(ultimaGrabacion.diagLocal.mejorCoste)}» (máx. ${ultimaGrabacion.diagLocal.umbralCoste})<br>` : ""}
        ${ultimaGrabacion.diag ? ` · servidor: ${ultimaGrabacion.diag.bytes} bytes, clave ${ultimaGrabacion.diag.token ? "sí" : "no"}, AudD ${esc(ultimaGrabacion.diag.status)}` : ""}</p>
        <audio controls src="${URL.createObjectURL(ultimaGrabacion.blob)}" style="width:100%"></audio>
        <p>Escucha la grabación: si apenas se oye la música, el micro no la está captando bien.</p>
      </details>` : ""}
    </div>`;
  }

  // ---------- hoja ----------
  const hoja = $("#hoja"), velo = $("#velo");
  function abrirHoja(html) {
    hoja.innerHTML = html; velo.hidden = false;
    requestAnimationFrame(() => hoja.classList.add("abierta")); hoja.setAttribute("aria-hidden", "false");
  }
  function cerrarHoja() { hoja.classList.remove("abierta"); velo.hidden = true; hoja.setAttribute("aria-hidden", "true"); }
  velo.addEventListener("click", cerrarHoja);
  let y0 = null;
  hoja.addEventListener("touchstart", (e) => { if (hoja.scrollTop <= 0) y0 = e.touches[0].clientY; }, { passive: true });
  hoja.addEventListener("touchend", (e) => { if (y0 !== null && e.changedTouches[0].clientY - y0 > 80) cerrarHoja(); y0 = null; });
  hoja.addEventListener("click", (e) => {
    const b = e.target.closest("[data-accion]"); if (!b) return;
    if (b.dataset.accion === "reintentar") { cerrarHoja(); escuchar(); }
    if (b.dataset.accion === "editar") { cerrarHoja(); abrirFormulario(b.dataset.id, b.dataset.titulo); }
  });

  // ---------- historial ----------
  function pintarHistorial() {
    const h = leer(K.hist, []);
    $("#vacioHist").hidden = h.length > 0;
    $("#btnBorrarHist").hidden = !h.length;
    $("#listaHist").innerHTML = h.map((e) => `<li data-id="${e.id}">
        ${e.cover ? `<img class="mini" src="${esc(e.cover)}" alt="" loading="lazy">` : `<div class="mini"></div>`}
        <div class="li-txt"><b>${esc(e.title)}</b><small>${esc(e.artist || "")}</small><small>${fecha(e.ts)}${e.pos ? " · 📍" : ""}</small></div>
      </li>`).join("");
  }
  $("#listaHist").addEventListener("click", (ev) => {
    const li = ev.target.closest("li"); if (!li) return;
    const e = leer(K.hist, []).find((x) => String(x.id) === li.dataset.id); if (e) abrirHoja(htmlFicha(e));
  });
  $("#btnBorrarHist").addEventListener("click", () => {
    if (confirm("¿Vaciar todo el historial?")) { guardar(K.hist, []); pintarHistorial(); }
  });

  // ---------- catálogo: marchas y hermandades ----------
  let modo = "marchas";
  document.querySelectorAll(".seg").forEach((b) => b.addEventListener("click", () => {
    modo = b.dataset.modo; document.querySelectorAll(".seg").forEach((x) => x.classList.toggle("activo", x === b)); pintarCatalogo();
  }));
  $("#buscar").addEventListener("input", pintarCatalogo);

  function pintarCatalogo() {
    const q = norm($("#buscar").value);
    const cat = catalogo();
    const ok = (m) => !q || norm([m.titulo, m.compositor, ...(m.hermandades || [])].join(" ")).includes(q);
    if (modo === "marchas") {
      $("#listaCat").innerHTML = cat.filter(ok).map((m) => `<li data-id="${esc(m.id)}">
        <div class="li-txt"><b>${esc(m.titulo)}</b><small>${esc([m.compositor, m.anio].filter(Boolean).join(" · ") || "Sin datos")}</small>
        ${m.tipo ? `<small>${esc(m.tipo)}</small>` : ""}</div></li>`).join("") || `<p class="vacio">Sin resultados.</p>`;
    } else {
      const mapa = {};
      cat.forEach((m) => (m.hermandades || []).forEach((h) => (mapa[h] ||= []).push(m)));
      const filas = Object.keys(mapa).sort((a, b) => a.localeCompare(b, "es"))
        .filter((h) => !q || norm(h).includes(q) || mapa[h].some((m) => norm(m.titulo).includes(q)));
      $("#listaCat").innerHTML = filas.map((h) => `<li data-herm="${esc(h)}">
        <div class="li-txt"><b>${esc(h)}</b><small>${esc(mapa[h].map((m) => m.titulo).join(" · "))}</small></div>
        <span class="li-cnt">${mapa[h].length}</span></li>`).join("")
        || `<p class="vacio">Aún no hay hermandades. Añádelas desde la ficha de cada marcha.</p>`;
    }
  }
  $("#listaCat").addEventListener("click", (ev) => {
    const li = ev.target.closest("li"); if (!li) return;
    if (li.dataset.herm) { $("#buscar").value = li.dataset.herm; document.querySelector('.seg[data-modo="marchas"]').click(); return; }
    const m = catalogo().find((x) => x.id === li.dataset.id); if (!m) return;
    abrirHoja(`<div class="asa"></div><div class="ficha-cab"><div class="portada"></div>
      <div><h3>${esc(m.titulo)}</h3><p>${esc(m.compositor || "")}</p></div></div>
      ${bloqueCatalogo(m)}${enlacesEscucha({ title: m.titulo, artist: "marcha procesional" })}
      <div class="enlaces" style="margin-top:14px"><button class="chip ghost" data-accion="editar" data-id="${esc(m.id)}">Editar ficha / hermandades</button></div>`);
  });

  // ---------- formulario ----------
  const dlg = $("#dlgMarcha"), frm = $("#frmMarcha");
  $("#btnNueva").addEventListener("click", () => abrirFormulario("", ""));
  $("#frmCancelar").addEventListener("click", () => dlg.close());
  function abrirFormulario(id, titulo) {
    const m = id ? catalogo().find((x) => x.id === id) : null;
    $("#frmTitulo").textContent = m ? "Editar marcha" : "Añadir marcha";
    frm.elements.id.value = m?.id || "";
    frm.titulo.value = m?.titulo || titulo || "";
    frm.compositor.value = m?.compositor || "";
    frm.anio.value = m?.anio || "";
    frm.tipo.value = m?.tipo || "";
    frm.hermandades.value = (m?.hermandades || []).join(", ");
    frm.nota.value = m?.nota || "";
    dlg.showModal();
  }
  frm.addEventListener("submit", (e) => {
    e.preventDefault();
    const titulo = frm.titulo.value.trim(); if (!titulo) return;
    const id = frm.elements.id.value || slug(titulo);
    const extra = leer(K.extra, {});
    extra[id] = {
      ...(extra[id] || {}), id, titulo,
      compositor: frm.compositor.value.trim(),
      anio: parseInt(frm.anio.value, 10) || null,
      tipo: frm.tipo.value,
      hermandades: frm.hermandades.value.split(",").map((s) => s.trim()).filter(Boolean),
      nota: frm.nota.value.trim(),
    };
    if (!extra[id].alias) extra[id].alias = [];
    guardar(K.extra, extra);
    dlg.close(); toast("Marcha guardada"); pintarCatalogo();
  });

  // ---------- demo (?demo) ----------
  function simular() {
    ocupado = true; wrap.classList.add("escuchando"); lema.textContent = "Escuchando a la banda…";
    let p = 0; const t = setInterval(() => { p += 0.1; arco.style.strokeDashoffset = 654 * (1 - Math.min(1, p)); }, 100);
    setTimeout(() => {
      clearInterval(t); arco.style.strokeDashoffset = 654; wrap.classList.replace("escuchando", "pensando"); lema.textContent = "Buscando la marcha…";
      setTimeout(() => resultado({ title: "Amarguras", artist: "Banda de Música (demo)", album: "Marchas procesionales", release_date: "2019-03-01", spotify: "", apple_music: "", cover: "" }, null), 900);
    }, 1200);
  }

  // ---------- instalación PWA ----------
  let aviso = null;
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); aviso = e; $("#btnInstalar").hidden = false; });
  $("#btnInstalar").addEventListener("click", async () => { if (!aviso) return; aviso.prompt(); await aviso.userChoice; aviso = null; $("#btnInstalar").hidden = true; });
  const esIOS = /iphone|ipad|ipod/i.test(navigator.userAgent), standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  if (esIOS && !standalone && !leer("cornetapp.avisoIOS", false)) {
    setTimeout(() => { toast("Para instalarla: Compartir → Añadir a pantalla de inicio"); guardar("cornetapp.avisoIOS", true); }, 2500);
  }
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
})();
