// Calibración: fragmentos de las marchas indexadas con degradaciones (positivos) y audio que NO es la marcha (negativos).
// Uso: node tools/calibrar.mjs <carpeta_con_audio>
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { decodificar } from "./indexar.mjs";
const require = createRequire(import.meta.url);
const H = require("../huellas.js");
const base = H.prepararBase(JSON.parse(readFileSync(new URL("../huellas/base.json", import.meta.url))));

let semilla = 7; const rnd = () => ((semilla = (semilla * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());
const rms = (x) => Math.sqrt(x.reduce((s, v) => s + v * v, 0) / x.length);
const ruido = (x, snr) => { const r = rms(x) / 10 ** (snr / 20); return x.map((v) => v + gauss() * r); };
const movil = (x) => { // paso banda aproximado 250 Hz–3,5 kHz + eco de sala
  const y = new Float32Array(x.length); let lp = 0, hp = 0, prev = 0;
  for (let i = 0; i < x.length; i++) { lp += 0.6 * (x[i] - lp); hp = 0.9 * (hp + lp - prev); prev = lp; y[i] = hp; }
  for (let i = 1600; i < y.length; i++) y[i] += 0.35 * y[i - 1600] + 0.2 * (y[i - 3700] || 0);
  return y;
};
// Murmullo de gente: voces sintéticas (pulso glotal + formantes de vocales + sílabas) + ambiente
const VOCALES = [[730, 1090, 2440], [270, 2290, 3010], [300, 870, 2240], [530, 1840, 2480], [570, 840, 2410]];
function voz(n) {
  const y = new Float32Array(n); let f0 = 110 + rnd() * 140, fase = 0, v = VOCALES[0];
  const est = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < n; i++) {
    if (i % 1900 === 0) { v = VOCALES[Math.floor(rnd() * 5)]; f0 = Math.max(90, Math.min(260, f0 * (0.9 + rnd() * 0.2))); }
    fase += f0 / 16000; const pulso = fase >= 1 ? (fase -= 1, 1) : 0;
    let x = pulso + 0.02 * gauss(), out = 0;
    for (let k = 0; k < 3; k++) { // resonador de 2º orden por formante
      const r = 0.97, w = (2 * Math.PI * v[k]) / 16000, a1 = 2 * r * Math.cos(w), a2 = -r * r;
      const yk = x + a1 * est[2 * k] + a2 * est[2 * k + 1]; est[2 * k + 1] = est[2 * k]; est[2 * k] = yk; out += yk / (k + 1);
    }
    const silaba = 0.5 + 0.5 * Math.sin((2 * Math.PI * 4.3 * i) / 16000 + f0);
    y[i] = out * silaba * silaba;
  }
  return y;
}
function murmullo(n, voces = 6) { const y = new Float32Array(n); for (let k = 0; k < voces; k++) { const v = voz(n), r = rms(v) || 1; for (let i = 0; i < n; i++) y[i] += v[i] / r; } const p = ruido(new Float32Array(n), 0); for (let i = 0; i < n; i++) y[i] += 0.0; return y; }
const conGente = (x, snr) => { const m = murmullo(x.length), r = rms(x) / 10 ** (snr / 20) / (rms(m) || 1); const y = new Float32Array(x.length); for (let i = 0; i < x.length; i++) y[i] = x[i] + m[i] * r + gauss() * r * 0.15; return y; };
const velocidad = (x, f) => { const n = Math.floor(x.length / f), y = new Float32Array(n); for (let i = 0; i < n; i++) { const p = i * f, k = Math.floor(p), a = p - k; y[i] = (x[k] || 0) * (1 - a) + (x[k + 1] || 0) * a; } return y; };
const DUR = +(process.env.DUR || 12);
const trozo = (x, s, d = DUR) => x.slice(Math.floor(s * 16000), Math.floor((s + d) * 16000));
const melodiaSintetica = (seg) => { const y = new Float32Array(seg * 16000); let f = 300, ph = 0; for (let i = 0; i < y.length; i++) { if (i % 4000 === 0) f = 220 * 2 ** (Math.floor(rnd() * 24) / 12); ph += (2 * Math.PI * f) / 16000; y[i] = 0.3 * Math.sin(ph) + 0.15 * Math.sin(2 * ph) + 0.1 * Math.sin(3 * ph); } return y; };

const dir = process.argv[2];
const audios = readdirSync(dir).filter((f) => /\.(mp3|m4a|wav|flac)$/i.test(f)).map((f) => ({ f, pcm: decodificar(join(dir, f)) }));
const filas = [];
function prueba(etiqueta, esPositivo, pcm) {
  const q = H.analizar(pcm, true), r = H.buscar(base, q), d = H.decidir(r, q.hashes.length, q.segundos);
  const top = [...r].sort((a, b) => b.votos - a.votos)[0];
  filas.push({ etiqueta, esPositivo, votos: top.votos, azar: +top.azar.toFixed(2), coste: +[...r].sort((a, b) => a.coste - b.coste)[0].coste.toFixed(3), hashes: q.hashes.length / 2, decision: d ? `${d.metodo}` : "—", ok: esPositivo ? !!d : !d });
}
for (const { pcm } of audios) {
  const dur = pcm.length / 16000;
  for (const s of [5, 60, 150, 240, 330, dur - 30]) {
    const t = trozo(pcm, s);
    prueba(`limpio @${s | 0}s`, true, t);
    prueba(`móvil+ruido 0dB @${s | 0}s`, true, ruido(movil(t), 0));
    prueba(`móvil+gente 5dB @${s | 0}s`, true, movil(conGente(t, 5)));
    prueba(`móvil+gente 0dB @${s | 0}s`, true, movil(conGente(t, 0)));
    prueba(`móvil+gente -5dB @${s | 0}s`, true, movil(conGente(t, -5)));
    prueba(`tempo -5% + gente 3dB @${s | 0}s`, true, movil(conGente(velocidad(trozo(pcm, s, DUR + 1), 0.95), 3)));
    prueba(`NEG invertido @${s | 0}s`, false, ruido(movil(t.slice().reverse()), 8));
    prueba(`rosa -10dB @${s | 0}s`, true, ruido(movil(t), -10));
    prueba(`NEG solo gente @${s | 0}s`, false, movil(murmullo(16000 * DUR)));
  }
}
for (let i = 0; i < 4; i++) prueba(`NEG ruido blanco ${i}`, false, ruido(new Float32Array(16000 * 12), 0).map((v) => v * 0.1));
for (let i = 0; i < 6; i++) prueba(`NEG melodía aleatoria ${i}`, false, ruido(melodiaSintetica(12), 15));

console.table(filas.map(({etiqueta,votos,azar,coste,decision,ok})=>({etiqueta,votos,azar,coste,decision,ok})));
const pos = filas.filter((f) => f.esPositivo), neg = filas.filter((f) => !f.esPositivo);
console.log(`Positivos acertados: ${pos.filter((f) => f.ok).length}/${pos.length} · Negativos rechazados: ${neg.filter((f) => f.ok).length}/${neg.length}`);
