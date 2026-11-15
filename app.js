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
  let ocupado = false, grabador = null, stream = null, ctx = null, cancelar = null;

  $("#btnEscuchar").addEventListener("click", () => (ocupado ? cancelar?.() : escuchar()));

  function tipoSoportado() {
    const op = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus", "audio/aac"];
    return window.MediaRecorder ? op.find((t) => MediaRecorder.isTypeSupported?.(t)) || "" : null;
  }

  async function escuchar() {
    if (DEMO) return simular();
    const tipo = tipoSoportado();
    if (tipo === null || !navigator.mediaDevices?.getUserMedia) return toast("Este navegador no permite grabar audio.");
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch {
      return toast("Necesito permiso para usar el micrófono.");
    }
    ocupado = true;
    const posPromesa = pedirUbicacion();
    wrap.classList.add("escuchando");
    lema.textContent = "Escuchando a la banda…";
    estado.textContent = "Mantén el móvil hacia la música";

    // medidor de nivel para animar el botón
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      const an = ctx.createAnalyser(); an.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(an);
      const d = new Uint8Array(an.fftSize);
      const tick = () => { if (!ocupado || !ctx) return; an.getByteTimeDomainData(d);
        let s = 0; for (const v of d) s += ((v - 128) / 128) ** 2;
        wrap.style.setProperty("--nivel", Math.min(1, Math.sqrt(s / d.length) * 4).toFixed(2)); requestAnimationFrame(tick); };
      tick();
    } catch {}

    const trozos = [];
    grabador = new MediaRecorder(stream, tipo ? { mimeType: tipo } : undefined);
    grabador.ondataavailable = (e) => e.data.size && trozos.push(e.data);
    const fin = new Promise((res) => (grabador.onstop = res));
    grabador.start();

    const t0 = performance.now();
    let cancelado = false;
    const timer = setInterval(() => {
      const p = Math.min(1, (performance.now() - t0) / (SEGUNDOS * 1000));
      arco.style.strokeDashoffset = 654 * (1 - p);
      if (p >= 1) parar();
    }, 100);
    function parar() { clearInterval(timer); if (grabador?.state !== "inactive") grabador.stop(); }
    cancelar = () => { cancelado = true; parar(); };

    await fin;
    soltarMicro();
    wrap.classList.remove("escuchando");
    arco.style.strokeDashoffset = 654;
    if (cancelado) return reiniciar("Cancelado");

    const original = new Blob(trozos, { type: grabador.mimeType || tipo || "audio/webm" });
    wrap.classList.add("pensando");
    const blob = await aWav(original).catch(() => original);
    lema.textContent = "Buscando la marcha…";
    estado.textContent = "";
    try {
      const r = await fetch("/api/identify", { method: "POST", headers: { "content-type": blob.type }, body: blob });
      const data = await r.json().catch(() => ({ ok: false, error: r.status === 404 ? "El servidor de reconocimiento no está disponible." : "Respuesta no válida." }));
      if (!data.ok) throw new Error(data.error || "Error al reconocer");
      const pos = await posPromesa;
      ultimaGrabacion = { blob, seg: ((performance.now() - t0) / 1000).toFixed(1), diag: data.diag };
      resultado(data.match, pos);
    } catch (e) {
      toast(e.message);
      reiniciar();
    }
  }

  // Convierte la grabación a WAV mono 16 kHz: formato que el reconocedor siempre lee bien
  async function aWav(b) {
    const AC = window.AudioContext || window.webkitAudioContext;
    const ac = new AC();
    const ab = await b.arrayBuffer();
    const buf = await new Promise((ok, ko) => { const p = ac.decodeAudioData(ab, ok, ko); if (p && p.then) p.then(ok, ko); });
    ac.close().catch(() => {});
    const SR = 16000, n = Math.ceil(buf.duration * SR);
    const off = new (window.OfflineAudioContext || window.webkitOfflineAudioContext)(1, n, SR);
    const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start();
    const pcm = (await off.startRendering()).getChannelData(0);
    let pico = 0; for (const v of pcm) pico = Math.max(pico, Math.abs(v));
    const g = pico > 0 ? Math.min(8, 0.9 / pico) : 1; // normaliza el volumen
    const dv = new DataView(new ArrayBuffer(44 + n * 2));
    const w = (o, t) => [...t].forEach((c, i) => dv.setUint8(o + i, c.charCodeAt(0)));
    w(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); w(8, "WAVEfmt "); dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, SR, true); dv.setUint32(28, SR * 2, true);
    dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); w(36, "data"); dv.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i] * g)) * 32767, true);
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
