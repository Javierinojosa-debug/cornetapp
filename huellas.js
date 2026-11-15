/* CornetApp — motor de huellas.
   Mismo código en el navegador (reconocer) y en Node (indexar marchas), para que las huellas coincidan.
   Entrada: PCM mono a 16 kHz (Float32Array).
   1) Huella acústica (picos del espectrograma emparejados, estilo Shazam): reconoce la MISMA grabación aunque haya ruido.
   2) Huella de melodía (croma de 12 notas + DTW con transposición): reconoce la misma marcha tocada por otra banda. */
(function (root) {
  const SR = 8000, N = 1024, HOP = 256;            // 128 ms de ventana, 32 ms de salto
  const FMIN = 10, FMAX = 400;                     // bins ≈ 78 Hz – 3,1 kHz
  const NB_T = 6, NB_F = 10;                       // vecindario del máximo local (±frames, ±bins)
  const FANOUT = 3, DTMAX = 63;                    // parejas por pico, distancia máxima (≈2 s)
  const CROMA_AGRUPA = 6;                          // 6 frames ≈ 192 ms por vector de croma

  // ---------- utilidades ----------
  function a8k(pcm16) {                            // 16 kHz → 8 kHz (media de pares)
    const n = pcm16.length >> 1, o = new Float32Array(n);
    for (let i = 0; i < n; i++) o[i] = 0.5 * (pcm16[2 * i] + pcm16[2 * i + 1]);
    return o;
  }
  const HANN = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const REV = (() => { const r = new Uint16Array(N), b = Math.log2(N); for (let i = 0; i < N; i++) { let x = i, y = 0; for (let k = 0; k < b; k++) { y = (y << 1) | (x & 1); x >>= 1; } r[i] = y; } return r; })();
  function fft(re, im) {
    for (let i = 0; i < N; i++) { const j = REV[i]; if (j > i) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; } }
    for (let s = 2; s <= N; s <<= 1) {
      const h = s >> 1, a = (-2 * Math.PI) / s;
      for (let k = 0; k < h; k++) {
        const wr = Math.cos(a * k), wi = Math.sin(a * k);
        for (let i = k; i < N; i += s) {
          const j = i + h, tr = wr * re[j] - wi * im[j], ti = wr * im[j] + wi * re[j];
          re[j] = re[i] - tr; im[j] = im[i] - ti; re[i] += tr; im[i] += ti;
        }
      }
    }
  }

  // Espectrograma de potencia (frames × bins 0..FMAX)
  function espectro(pcm16) {
    const x = a8k(pcm16), T = Math.max(0, Math.floor((x.length - N) / HOP) + 1);
    const S = new Float32Array(T * (FMAX + 1));
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let t = 0; t < T; t++) {
      const o = t * HOP;
      for (let i = 0; i < N; i++) { re[i] = x[o + i] * HANN[i]; im[i] = 0; }
      fft(re, im);
      for (let f = 0; f <= FMAX; f++) S[t * (FMAX + 1) + f] = re[f] * re[f] + im[f] * im[f];
    }
    return { S, T, F: FMAX + 1 };
  }

  // ---------- 1) huella acústica ----------
  function maxFiltro1D(src, dst, len, stride, count, offset, r) { // máximo deslizante simple
    for (let c = 0; c < count; c++) {
      const base = offset(c);
      for (let i = 0; i < len; i++) {
        let m = -Infinity; const a = Math.max(0, i - r), b = Math.min(len - 1, i + r);
        for (let k = a; k <= b; k++) { const v = src[base + k * stride]; if (v > m) m = v; }
        dst[base + i * stride] = m;
      }
    }
  }
  // Picos con "prominencia": cuánto sobresale cada máximo local sobre la media de su entorno.
  // No depende del volumen global, así que el ruido de fondo (gente, viento) no tapa los picos de la música.
  function picos({ S, T, F }, porSegundo) {
    const L = new Float32Array(S.length);
    for (let i = 0; i < S.length; i++) L[i] = 10 * Math.log10(S[i] + 1e-10);
    const A = new Float32Array(L.length), B = new Float32Array(L.length);
    maxFiltro1D(L, A, F, 1, T, (t) => t * F, NB_F);
    maxFiltro1D(A, B, T, F, F, (f) => f, NB_T);
    // media local (caja ±12 frames × ±20 bins) con imagen integral
    const W = F + 1, I = new Float64Array((T + 1) * W);
    for (let t = 0; t < T; t++) { let fila = 0; for (let f = 0; f < F; f++) { fila += L[t * F + f]; I[(t + 1) * W + f + 1] = I[t * W + f + 1] + fila; } }
    const media = (t, f) => { const t0 = Math.max(0, t - 12), t1 = Math.min(T, t + 13), f0 = Math.max(0, f - 20), f1 = Math.min(F, f + 21);
      return (I[t1 * W + f1] - I[t0 * W + f1] - I[t1 * W + f0] + I[t0 * W + f0]) / ((t1 - t0) * (f1 - f0)); };
    const cand = [];
    for (let t = 0; t < T; t++) for (let f = FMIN; f <= FMAX; f++) {
      const i = t * F + f;
      if (L[i] === B[i]) { const p = L[i] - media(t, f); if (p > 4) cand.push([t, f, p]); }
    }
    // tope por segundo: se quedan los más prominentes
    const porVentana = new Map(), V = Math.round(SR / HOP); // ≈31 frames = 1 s
    for (const c of cand) { const k = Math.floor(c[0] / V); let l = porVentana.get(k); if (!l) porVentana.set(k, (l = [])); l.push(c); }
    const P = [];
    for (const l of porVentana.values()) { l.sort((a, b) => b[2] - a[2]); for (let i = 0; i < Math.min(porSegundo, l.length); i++) P.push([l[i][0], l[i][1]]); }
    P.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return P;
  }
  function hashes(P, fanout) {
    const H = [];
    for (let i = 0; i < P.length; i++) {
      const [t1, f1] = P[i]; let n = 0;
      for (let j = i + 1; j < P.length && n < fanout; j++) {
        const [t2, f2] = P[j], dt = t2 - t1;
        if (dt < 1) continue;
        if (dt > DTMAX) break;
        if (Math.abs(f2 - f1) > 96) continue;
        H.push(((f1 << 15) | (f2 << 6) | dt) >>> 0, t1); n++;
      }
    }
    return H; // plano: [hash, t, hash, t, ...]
  }

  // ---------- 2) huella de melodía (croma) ----------
  const PC = new Int8Array(FMAX + 1).map((_, f) => {
    if (f < 20) return -1;                                   // < 156 Hz: demasiado grave para N=1024
    const hz = (f * SR) / N, m = Math.round(12 * Math.log2(hz / 440) + 69);
    return ((m % 12) + 12) % 12;
  });
  function croma({ S, T, F }) {
    const n = Math.floor(T / CROMA_AGRUPA), C = new Float32Array(n * 12);
    for (let k = 0; k < n; k++) {
      const v = C.subarray(k * 12, k * 12 + 12);
      for (let t = k * CROMA_AGRUPA; t < (k + 1) * CROMA_AGRUPA; t++)
        for (let f = 20; f <= FMAX; f++) v[PC[f]] += Math.sqrt(S[t * F + f]);
      let s = 0; for (let i = 0; i < 12; i++) { v[i] = Math.log1p(v[i]); s += v[i] * v[i]; }
      // quitar la media hace que el croma refleje la nota dominante, no el volumen
      let m = 0; for (let i = 0; i < 12; i++) m += v[i]; m /= 12;
      s = 0; for (let i = 0; i < 12; i++) { v[i] -= m; s += v[i] * v[i]; }
      s = Math.sqrt(s) || 1; for (let i = 0; i < 12; i++) v[i] /= s;
    }
    return { C, n };
  }
  // compacta para guardar: cada valor en [-1,1] → carácter '0'..'z' (0..74)
  const cromaATexto = ({ C }) => Array.from(C, (v) => String.fromCharCode(48 + Math.round((v + 1) * 37))).join("");
  const textoACroma = (s) => { const C = new Float32Array(s.length); for (let i = 0; i < s.length; i++) C[i] = (s.charCodeAt(i) - 48) / 37 - 1; return { C, n: s.length / 12 }; };

  // DTW de subsecuencia: mejor coste medio de alinear la consulta dentro de la marcha (pasos 1:1, 1:2, 2:1)
  function dtw(Q, D, rot) {
    const m = Q.n, n = D.n, INF = 1e9;
    let prev2 = new Float32Array(n + 1).fill(INF), prev = new Float32Array(n + 1).fill(INF);
    let lp2 = new Uint16Array(n + 1), lp = new Uint16Array(n + 1);
    const coste = (i, j) => { let d = 0; for (let k = 0; k < 12; k++) d += Q.C[i * 12 + ((k + rot) % 12)] * D.C[j * 12 + k]; return 1 - d; };
    for (let i = 0; i < m; i++) {
      const cur = new Float32Array(n + 1).fill(INF), lc = new Uint16Array(n + 1);
      for (let j = 1; j <= n; j++) {
        const c = coste(i, j - 1);
        if (i === 0) { cur[j] = c; lc[j] = 1; continue; }
        let best = prev[j - 1], L = lp[j - 1];                         // diagonal
        if (j >= 2 && prev[j - 2] < best) { best = prev[j - 2]; L = lp[j - 2]; }    // consulta más lenta
        if (i >= 2 && prev2[j - 1] + c < best) { best = prev2[j - 1] + c; L = lp2[j - 1] + 1; } // consulta más rápida
        cur[j] = best + c; lc[j] = L + 1;
      }
      prev2 = prev; lp2 = lp; prev = cur; lp = lc;
    }
    let mejor = INF;
    for (let j = 1; j <= n; j++) if (prev[j] < INF) mejor = Math.min(mejor, prev[j] / lp[j]);
    return mejor;
  }

  // ---------- API ----------
  // consulta = true para lo grabado con el móvil: más picos y más parejas, para recuperar las de la base aunque haya ruido
  function analizar(pcm16, consulta = false) {
    const E = espectro(pcm16);
    const P = picos(E, consulta ? 45 : 22);
    return { hashes: hashes(P, consulta ? 10 : FANOUT), croma: croma(E), segundos: pcm16.length / 16000 };
  }

  function prepararBase(base) {             // construye el índice hash → [marcha, t]
    const idx = new Map();
    base.marchas.forEach((m, k) => {
      const h = m.hashes;
      for (let i = 0; i < h.length; i += 2) { let l = idx.get(h[i]); if (!l) idx.set(h[i], (l = [])); l.push(k, h[i + 1]); }
      m._croma = textoACroma(m.croma);
    });
    base._idx = idx;
    return base;
  }

  function buscar(base, q) {
    // 1) acústica: votos por desfase temporal coherente
    const votos = base.marchas.map(() => new Map());
    for (let i = 0; i < q.hashes.length; i += 2) {
      const l = base._idx.get(q.hashes[i]); if (!l) continue;
      for (let k = 0; k < l.length; k += 2) {
        const d = l[k + 1] - q.hashes[i + 1], v = votos[l[k]];
        v.set(d, (v.get(d) || 0) + 1);
      }
    }
    const acustica = votos.map((v, k) => {
      let best = 0, at = 0, total = 0;
      for (const c of v.values()) total += c;
      for (const [d, c] of v) { const s = c + (v.get(d - 1) || 0) + (v.get(d + 1) || 0); if (s > best) { best = s; at = d; } }
      // votos esperados por azar en una ventana de 3 desfases
      const rango = (base.marchas[k].segundos + q.segundos) * SR / HOP;
      const azar = (3 * total) / Math.max(1, rango);
      return { votos: best, azar, segundo: Math.max(0, at * HOP / SR) };
    });
    // 2) melodía: mejor transposición
    const melodia = base.marchas.map((m) => {
      if (q.croma.n < 20) return { coste: 1, tono: 0 };
      let best = 9, tono = 0;
      for (let r = 0; r < 12; r++) { const c = dtw(q.croma, m._croma, r); if (c < best) { best = c; tono = r; } }
      return { coste: best, tono };
    });
    return base.marchas.map((m, k) => ({ id: m.id, titulo: m.titulo, banda: m.banda, ...acustica[k], ...melodia[k] }));
  }

  // Decisión: umbrales calibrados en pruebas (ver tools/calibrar.mjs)
  const UMBRAL = { votos: 12, votosMin: 9, vecesAzar: 10, votosRelacion: 0.001, coste: 0.19, costeLargo: 0.21 };
  function decidir(res, nHashes, segundos = 12) {
    if (!res.length) return null;
    const porVotos = [...res].sort((a, b) => b.votos - a.votos)[0];
    const significativo = porVotos.votos >= UMBRAL.votosMin && porVotos.votos >= UMBRAL.vecesAzar * (porVotos.azar + 0.5);
    if ((porVotos.votos >= UMBRAL.votos && porVotos.votos >= nHashes * UMBRAL.votosRelacion) || significativo)
      return { ...porVotos, metodo: "acustica", confianza: Math.min(1, porVotos.votos / 60) };
    const porMelodia = [...res].sort((a, b) => a.coste - b.coste)[0];
    const maxCoste = segundos >= 18 ? UMBRAL.costeLargo : UMBRAL.coste;
    if (porMelodia.coste <= maxCoste)
      return { ...porMelodia, metodo: "melodia", confianza: Math.max(0, Math.min(1, (UMBRAL.coste + 0.1 - porMelodia.coste) / 0.25)) };
    return null;
  }

  const API = { analizar, prepararBase, buscar, decidir, cromaATexto, UMBRAL, SR_ENTRADA: 16000 };
  if (typeof module !== "undefined" && module.exports) module.exports = API; else root.Huellas = API;
})(typeof self !== "undefined" ? self : this);
