// Mixamo in-browser exporter for Sleighbound.
//
// Paste this whole file into the DevTools console of a signed-in https://www.mixamo.com tab.
// It defines window.sbMixamoExport(list, opts) and does not run anything by itself.
// The access token is read from localStorage.access_token and only used for requests from this tab.
//
//   await sbMixamoExport()                       // the default list below (mirrors animations.json)
//   await sbMixamoExport([{ name: "wave", query: "waving" }])
//   await sbMixamoExport(null, { dryRun: true }) // search + pick + payload only, no exports
//
// Each clip is exported without skin (armature only, mixamorig:* bones) as FBX 2019 @ 30 fps and
// saved as <name>.fbx through a blob download. Chrome may ask once to "allow multiple downloads".
// Returns an array of { name, status, productId, productName, file, error }.
(() => {
  const API = "https://www.mixamo.com/api/v1";
  const PREFS = { format: "fbx7_2019", skin: "false", fps: "30", reducekf: "0" };
  const DEFAULT_LIST = [
    { name: "idle_happy", query: "happy idle" },
    { name: "wave", query: "waving" },
    { name: "cheer", query: "cheering", inplace: true },
    { name: "jump", query: "jump", inplace: true },
    { name: "victory", query: "victory", inplace: true },
    { name: "hit", query: "hit reaction" },
    { name: "sleep", query: "sleeping idle" },
    { name: "throw", query: "throw" },
    { name: "pick_up", query: "picking up" },
    { name: "clap", query: "clapping" },
  ];

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function token() {
    let t = localStorage.getItem("access_token") || "";
    t = t.replace(/^"|"$/g, "").replace(/^Bearer\s+/i, "").trim();
    if (!t) throw new Error("no localStorage.access_token: sign in at mixamo.com first");
    return t;
  }

  async function api(method, path, body, retries = 4) {
    let delay = 2000;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(API + path, {
          method,
          headers: {
            Authorization: "Bearer " + token(),
            "X-Api-Key": "mixamo2",
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (e) {
        if (attempt < retries) { await sleep(delay); delay = Math.min(delay * 2, 60000); continue; }
        throw new Error(`network error on ${method} ${path}: ${e.message}`);
      }
      if (res.status === 401) throw new Error("401: token expired: sign in at mixamo.com again and reload");
      if ([429, 500, 502, 503, 504].includes(res.status) && attempt < retries) {
        const ra = parseFloat(res.headers.get("Retry-After"));
        await sleep(Number.isFinite(ra) ? ra * 1000 : delay);
        delay = Math.min(delay * 2, 60000);
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} on ${method} ${path}: ${text.slice(0, 300)}`);
      if (!text) return {};
      try { return JSON.parse(text); } catch { throw new Error(`${method} ${path}: non-JSON response`); }
    }
  }

  async function search(query) {
    const q = new URLSearchParams({ page: "1", limit: "48", order: "", type: "Motion,MotionPack", query });
    const res = await api("GET", "/products?" + q.toString());
    const results = Array.isArray(res) ? res : res.results;
    if (!Array.isArray(results)) throw new Error(`search '${query}': unexpected response shape`);
    return results;
  }

  function pickProduct(results, e) {
    if (!results.length) throw new Error(`no search results for '${e.query}'`);
    const lc = (s) => String(s || "").trim().toLowerCase();
    if (Number.isInteger(e.pick)) {
      if (e.pick < 0 || e.pick >= results.length) throw new Error(`pick index ${e.pick} out of range`);
      return results[e.pick];
    }
    if (typeof e.pick === "string") {
      const hit = results.find((r) => lc(r.name) === lc(e.pick));
      if (!hit) throw new Error(`no result named '${e.pick}'; first: ${results.slice(0, 10).map((r) => r.name).join(", ")}`);
      return hit;
    }
    const motions = results.filter((r) => (r.type || "Motion") === "Motion");
    const exact = motions.find((r) => lc(r.name) === lc(e.query));
    if (exact) return exact;
    if (motions.length) return motions[0];
    throw new Error(`only motion packs found for '${e.query}'; set 'pick'`);
  }

  function paramsString(p) {
    if (p == null) return "";
    if (typeof p === "string") return p;
    const num = (v) => (typeof v === "boolean" ? (v ? "1" : "0") : String(v));
    if (!Array.isArray(p)) return Object.values(p).map(num).join(",");
    return p.map((x) => (Array.isArray(x) ? num(x[x.length - 1]) : x && typeof x === "object" ? num(x.value ?? 0) : num(x))).join(",");
  }

  function buildExport(detail, product, e, characterId) {
    const details = (detail && detail.details) || {};
    let gms = details.gms_hash;
    if (Array.isArray(gms)) gms = gms[0];
    if (!gms || gms["model-id"] === undefined) throw new Error(`product ${product.id} has no details.gms_hash (motion pack?)`);
    let inplace = e.inplace ?? !!gms.inplace;
    if (inplace && details.supports_inplace === false) inplace = false;
    return {
      character_id: characterId,
      gms_hash: [{
        "model-id": gms["model-id"],
        mirror: !!(e.mirror ?? gms.mirror),
        trim: gms.trim ?? [0, 100],
        overdrive: gms.overdrive ?? 0,
        params: paramsString(gms.params),
        "arm-space": gms["arm-space"] ?? 0,
        inplace: !!inplace,
      }],
      preferences: { ...PREFS },
      product_name: detail.name || product.name || e.name,
      type: "Motion",
    };
  }

  async function waitForExport(characterId, exportRes, timeoutMs) {
    const jobId = exportRes && (exportRes.uuid || exportRes.job_uuid || exportRes.id);
    const t0 = Date.now();
    let delay = 3000;
    await sleep(2000);
    for (;;) {
      const st = await api("GET", `/characters/${characterId}/monitor`);
      const status = String(st.status || "").toLowerCase();
      const seen = st.uuid || st.job_uuid;
      const stale = jobId && seen && String(seen) !== String(jobId);
      if (status === "completed" && !stale) {
        if (typeof st.job_result !== "string" || !st.job_result.startsWith("http")) throw new Error("completed but job_result is not a URL");
        return st.job_result;
      }
      if (status === "failed" && !stale) throw new Error("export failed: " + (st.message || st.job_result || JSON.stringify(st)));
      if (Date.now() - t0 > timeoutMs) throw new Error(`export timed out (last status: ${status || "unknown"})`);
      await sleep(delay);
      delay = Math.min(delay * 1.5, 15000);
    }
  }

  async function saveAs(url, filename) {
    // Presigned S3 URL: fetched without auth headers.
    let blob;
    try {
      const res = await fetch(url, { credentials: "omit" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      blob = await res.blob();
    } catch (err) {
      // CORS fallback: the browser names the file itself; rename to `filename` afterwards.
      const a = document.createElement("a");
      a.href = url; a.download = filename; a.rel = "noopener";
      document.body.appendChild(a); a.click(); a.remove();
      return { bytes: null, note: `blob fetch failed (${err.message}); opened direct link, rename to ${filename}` };
    }
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 30000);
    return { bytes: blob.size, note: null };
  }

  window.sbMixamoExport = async function sbMixamoExport(list, opts = {}) {
    const { dryRun = false, characterId = null, delayMs = 6000, timeoutMs = 300000 } = opts;
    list = list || DEFAULT_LIST;
    let charId = characterId;
    if (!charId) {
      const prim = await api("GET", "/characters/primary");
      charId = prim.primary_character_id || prim.id || prim.character_id;
      if (!charId) throw new Error("no character id from /characters/primary; pass opts.characterId");
    }
    console.log(`[sb] character ${charId}; ${list.length} clip(s)${dryRun ? " (dry run)" : ""}`);
    const summary = [];
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      const row = { name: e.name, status: "pending", productId: null, productName: null, file: `${e.name}.fbx`, error: null };
      summary.push(row);
      if (i && !dryRun) await sleep(delayMs);
      try {
        const product = pickProduct(await search(e.query), e);
        row.productId = product.id; row.productName = product.name;
        const q = new URLSearchParams({ similar: "0", character_id: charId });
        const detail = await api("GET", `/products/${product.id}?${q.toString()}`);
        const payload = buildExport(detail, product, e, charId);
        if (dryRun) { row.status = "dry-run"; row.payload = payload; console.log(`[sb] ${e.name}: '${product.name}'`, payload); continue; }
        console.log(`[sb] ${i + 1}/${list.length} ${e.name}: exporting '${product.name}'`);
        const res = await api("POST", "/animations/export", payload);
        const url = await waitForExport(charId, res, timeoutMs);
        const saved = await saveAs(url, row.file);
        row.status = "saved"; row.bytes = saved.bytes; if (saved.note) row.note = saved.note;
        console.log(`[sb] ${e.name}: saved ${row.file}`);
      } catch (err) {
        row.status = "error"; row.error = err.message;
        console.warn(`[sb] ${e.name}: ${err.message}`);
        if (/^401/.test(err.message)) break;
      }
    }
    console.table(summary.map(({ payload, ...r }) => r));
    return summary;
  };

  console.log("sbMixamoExport(list?, {dryRun, characterId, delayMs, timeoutMs}) is ready");
})();
