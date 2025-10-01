// pages/api/notion/query.js
export default async function handler(req, res) {
  // CORS básico para testes
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type, x-api-key");

  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  // Chave do seu proxy (bate com INTERNAL_API_KEY na Vercel)
  const clientKey = req.headers["x-api-key"];
  if (!clientKey || clientKey !== process.env.INTERNAL_API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const {
    database_id,          // opcional se você definiu NOTION_DATABASE_ID
    filter,               // opcional - filtro nativo do Notion
    sorts,                // opcional - sorts nativos do Notion
    page_size = 25,       // opcional
    start_cursor,         // opcional
    all = false,          // se true, pagina até o fim
    select_properties     // opcional - limitar campos no flatten
  } = req.body || {};

  const dbId = database_id || process.env.NOTION_DATABASE_ID;
  if (!dbId) {
    res.status(400).json({ error: "Provide database_id or set NOTION_DATABASE_ID" });
    return;
  }

  const notionToken = process.env.NOTION_SECRET;
  if (!notionToken) {
    res.status(500).json({ error: "Server misconfigured: NOTION_SECRET is missing" });
    return;
  }

  try {
    const headers = {
      Authorization: `Bearer ${notionToken}`,
      "Content-Type": "application/json",
      "Notion-Version": process.env.NOTION_VERSION || "2022-06-28",
    };

    let results = [];
    let has_more = true;
    let next_cursor_local = start_cursor ?? null;

    do {
      const body = {
        page_size,
        filter,
        sorts,
        ...(next_cursor_local ? { start_cursor: next_cursor_local } : {}),
      };

      const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (!r.ok) {
        const t = await r.text();
        return res.status(r.status).json({ error: "Notion API error", details: t });
      }

      const data = await r.json();
      const pages = (data.results || []).map(p => flattenPage(p, select_properties));

      results.push(...pages);
      has_more = !!data.has_more;
      next_cursor_local = data.next_cursor || null;

      if (!all) break;
    } while (has_more);

    res.status(200).json({
      items: results,
      has_more,
      next_cursor: next_cursor_local,
      database_id: dbId
    });
  } catch (err) {
    console.error("Query error:", err);
    res.status(500).json({ error: err.message || "Internal server error" });
  }
}

function flattenPage(page, selectProps) {
  const base = {
    id: page.id,
    created_time: page.created_time,
    last_edited_time: page.last_edited_time,
    url: page.url,
  };

  const props = page.properties || {};
  const out = {};

  for (const [key, val] of Object.entries(props)) {
    if (Array.isArray(selectProps) && selectProps.length && !selectProps.includes(key)) continue;
    if (!val || !val.type) { out[key] = null; continue; }

    switch (val.type) {
      case "title":        out[key] = (val.title || []).map(t => t.plain_text).join(""); break;
      case "rich_text":    out[key] = (val.rich_text || []).map(t => t.plain_text).join(""); break;
      case "number":       out[key] = val.number ?? null; break;
      case "select":       out[key] = val.select ? val.select.name : null; break;
      case "multi_select": out[key] = (val.multi_select || []).map(s => s.name); break;
      case "status":       out[key] = val.status ? val.status.name : null; break;
      case "checkbox":     out[key] = !!val.checkbox; break;
      case "date":         out[key] = val.date ? { start: val.date.start, end: val.date.end } : null; break;
      case "people":       out[key] = (val.people || []).map(p => p.name || p.id); break;
      case "files":        out[key] = (val.files || []).map(f => f.file?.url || f.external?.url).filter(Boolean); break;
      case "relation":     out[key] = (val.relation || []).map(r => r.id); break;
      case "url":          out[key] = val.url || null; break;
      case "email":        out[key] = val.email || null; break;
      case "phone_number": out[key] = val.phone_number || null; break;
      case "formula":      out[key] = extractFormula(val.formula); break;
      default:             out[key] = null;
    }
  }

  return { ...base, ...out };
}

function extractFormula(f) {
  if (!f || !f.type) return null;
  return f[f.type] ?? null;
}
