// CornetApp — reconocimiento de marchas vía AudD (https://audd.io)
// La clave se guarda en la variable de entorno AUDD_API_TOKEN de Netlify.

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

export default async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "Método no permitido" }, 405);

  const token = globalThis.Netlify?.env?.get("AUDD_API_TOKEN") ?? process.env.AUDD_API_TOKEN;
  const buf = await req.arrayBuffer();
  if (buf.byteLength < 2000) return json({ ok: false, error: "La grabación está vacía o es demasiado corta." }, 400);
  if (buf.byteLength > 9.5 * 1024 * 1024) return json({ ok: false, error: "La grabación es demasiado grande." }, 413);

  const type = (req.headers.get("content-type") || "audio/webm").split(";")[0];
  const ext = type.includes("mp4") || type.includes("aac") ? "m4a" : type.includes("ogg") ? "ogg" : type.includes("wav") ? "wav" : "webm";

  const fd = new FormData();
  fd.append("file", new Blob([buf], { type }), `clip.${ext}`);
  fd.append("return", "apple_music,spotify");
  if (token) fd.append("api_token", token);

  let data;
  try {
    const r = await fetch("https://api.audd.io/", { method: "POST", body: fd });
    data = await r.json();
  } catch (e) {
    return json({ ok: false, error: "No se pudo contactar con el servicio de reconocimiento." }, 502);
  }

  if (data.status === "error") {
    const code = data.error?.error_code;
    const msg =
      code === 901 ? "Se ha agotado el uso gratuito: falta configurar la clave de AudD en Netlify." :
      code === 900 ? "La clave de AudD no es válida." :
      data.error?.error_message || "Error del servicio de reconocimiento.";
    return json({ ok: false, error: msg, code }, 502);
  }

  const r = data.result;
  if (!r) return json({ ok: true, match: null });

  const appleArt = r.apple_music?.artwork?.url?.replace("{w}", "600").replace("{h}", "600");
  return json({
    ok: true,
    match: {
      title: r.title || "",
      artist: r.artist || "",
      album: r.album || "",
      release_date: r.release_date || "",
      label: r.label || "",
      song_link: r.song_link || "",
      spotify: r.spotify?.external_urls?.spotify || "",
      apple_music: r.apple_music?.url || "",
      cover: r.spotify?.album?.images?.[0]?.url || appleArt || "",
    },
  });
};

export const config = { path: "/api/identify" };
