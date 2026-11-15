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
const velocidad = (x, f) => { const n = Math.floor(x.length / f), y = new Float32Array(n); for (let i = 0; i < n; i++) { const p = i * f, k = Math.floor(p), a = p - k; y[i] = (x[k] || 0) * (1 - a) + (x[k + 1] || 0) * a; } return y; };
const trozo = (x, s, d = 12) => x.slice(Math.floor(s * 16000), Math.floor((s + d) * 16000));
const melodiaSintetica = (seg) => { const y = new Float32Array(seg * 16000); let f = 300, ph = 0; for (let i = 0; i < y.length; i++) { if (i % 4000 === 0) f = 220 * 2 ** (Math.floor(rnd() * 24) / 12); ph += (2 * Math.PI * f) / 16000; y[i] = 0.3 * Math.sin(ph) + 0.15 * Math.sin(2 * ph) + 0.1 * Math.sin(3 * ph); } return y; };

const dir = process.argv[2];
const audios = readdirSync(dir).filter((f) => /\.(mp3|m4a|wav|flac)$/i.test(f)).map((f) => ({ f, pcm: decodificar(join(dir, f)) }));
const filas = [];
function prueba(etiqueta, esPositivo, pcm) {
  const q = H.analizar(pcm), r = H.buscar(base, q), d = H.decidir(r, q.hashes.length);
  const top = [...r].sort((a, b) => b.votos - a.votos)[0];
  filas.push({ etiqueta, esPositivo, votos: top.votos, coste: +[...r].sort((a, b) => a.coste - b.coste)[0].coste.toFixed(3), hashes: q.hashes.length / 2, decision: d ? `${d.metodo}` : "—", ok: esPositivo ? !!d : !d });
}
for (const { pcm } of audios) {
  const dur = pcm.length / 16000;
  for (const s of [5, 60, 150, 240, 330, dur - 30]) {
    const t = trozo(pcm, s);
    prueba(`limpio @${s | 0}s`, true, t);
    prueba(`ruido 10dB @${s | 0}s`, true, ruido(t, 10));
    prueba(`móvil+ruido 5dB @${s | 0}s`, true, ruido(movil(t), 5));
    prueba(`móvil+ruido 0dB @${s | 0}s`, true, ruido(movil(t), 0));
    prueba(`tempo/tono +4% @${s | 0}s`, true, ruido(movil(velocidad(trozo(pcm, s, 13), 1.04)), 8));
    prueba(`tempo/tono -5% @${s | 0}s`, true, ruido(movil(velocidad(trozo(pcm, s, 13), 0.95)), 8));
    prueba(`NEG invertido @${s | 0}s`, false, ruido(movil(t.slice().reverse()), 8));
  }
}
for (let i = 0; i < 4; i++) prueba(`NEG ruido blanco ${i}`, false, ruido(new Float32Array(16000 * 12), 0).map((v) => v * 0.1));
for (let i = 0; i < 6; i++) prueba(`NEG melodía aleatoria ${i}`, false, ruido(melodiaSintetica(12), 15));

console.table(filas);
const pos = filas.filter((f) => f.esPositivo), neg = filas.filter((f) => !f.esPositivo);
console.log(`Positivos acertados: ${pos.filter((f) => f.ok).length}/${pos.length} · Negativos rechazados: ${neg.filter((f) => f.ok).length}/${neg.length}`);
