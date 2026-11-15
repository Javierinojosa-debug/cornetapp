// Uso: node tools/indexar.mjs <carpeta_con_audio>   (los archivos se llaman "Título - Banda.ext")
// Genera huellas/base.json. El audio NO se copia al repositorio: solo las huellas.
import { execFileSync } from "node:child_process";
import { readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { join, extname, basename, dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const H = require("../huellas.js");
const raiz = join(dirname(fileURLToPath(import.meta.url)), "..");

export function decodificar(ruta) {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", ruta, "-ac", "1", "-ar", "16000", "-f", "f32le", "-"], { maxBuffer: 1 << 30 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}
const slug = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2];
  const marchas = [];
  for (const f of readdirSync(dir).filter((f) => /\.(mp3|m4a|wav|flac|ogg|aac)$/i.test(f)).sort()) {
    const [titulo, banda = ""] = basename(f, extname(f)).split(" - ").map((s) => s.trim());
    const pcm = decodificar(join(dir, f));
    const a = H.analizar(pcm);
    marchas.push({ id: slug(titulo + "-" + banda), titulo, banda, segundos: Math.round(a.segundos), hashes: a.hashes, croma: H.cromaATexto(a.croma) });
    console.log(`✓ ${titulo} — ${banda}: ${Math.round(a.segundos)} s, ${a.hashes.length / 2} hashes, ${a.croma.n} cromas`);
  }
  mkdirSync(join(raiz, "huellas"), { recursive: true });
  writeFileSync(join(raiz, "huellas/base.json"), JSON.stringify({ version: 1, generada: new Date().toISOString(), marchas }));
  console.log("huellas/base.json listo");
}
