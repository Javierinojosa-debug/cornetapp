// CornetApp — base compartida de huellas aprendidas desde la app (Netlify Blobs).
// GET  /api/huellas  → { marchas: [...] }
// POST /api/huellas  → guarda una marcha { titulo, banda, segundos, hashes, croma }
// DELETE /api/huellas?id=...  → borra una marcha aprendida
import { getStore } from "@netlify/blobs";

const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...extra } });
const slug = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
const texto = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");

export default async (req) => {
  const store = getStore({ name: "marchas", consistency: "strong" });

  if (req.method === "GET") {
    const { blobs } = await store.list();
    const marchas = (await Promise.all(blobs.map((b) => store.get(b.key, { type: "json" }).catch(() => null)))).filter(Boolean);
    return json({ marchas }, 200, { "cache-control": "no-store" });
  }

  if (req.method === "POST") {
    let m;
    try { m = await req.json(); } catch { return json({ ok: false, error: "JSON no válido" }, 400); }
    const titulo = texto(m.titulo, 120), banda = texto(m.banda, 120);
    const h = m.hashes, croma = m.croma, segundos = Number(m.segundos);
    if (!titulo) return json({ ok: false, error: "Falta el título" }, 400);
    if (!Array.isArray(h) || h.length < 200 || h.length % 2 || h.length > 400000 || !h.every((x) => Number.isInteger(x) && x >= 0 && x < 2 ** 32))
      return json({ ok: false, error: "Huella acústica no válida" }, 400);
    if (typeof croma !== "string" || croma.length % 12 || croma.length > 120000 || !/^[0-z]*$/.test(croma))
      return json({ ok: false, error: "Huella de melodía no válida" }, 400);
    if (!(segundos > 20 && segundos < 1800)) return json({ ok: false, error: "Duración no válida" }, 400);
    const id = `${slug(titulo + "-" + banda)}-${Date.now().toString(36)}`;
    await store.setJSON(id, { id, titulo, banda, segundos: Math.round(segundos), hashes: h, croma, aprendida: true, creada: new Date().toISOString() });
    return json({ ok: true, id });
  }

  if (req.method === "DELETE") {
    const id = new URL(req.url).searchParams.get("id");
    if (!id) return json({ ok: false, error: "Falta id" }, 400);
    await store.delete(id);
    return json({ ok: true });
  }

  return json({ ok: false, error: "Método no permitido" }, 405);
};

export const config = { path: "/api/huellas" };
