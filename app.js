const ALLOWED_ORIGINS = [
  "http://localhost:8000",
  "http://127.0.0.1:8000"
];

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      if (!env.DB) throw new Error("D1 binding DB is missing.");
      if (!env.FAMILY_PIN) throw new Error("Worker secret FAMILY_PIN is missing.");

      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";

      if (path === "/health" && request.method === "GET") {
        return json({ ok: true, service: "Dad's Anxiety Support API" }, 200, cors);
      }

      requirePin(request, env);

      if (path === "/api/bootstrap" && request.method === "GET") {
        const [categories, dashboard, recent] = await Promise.all([
          getCategories(env),
          getDashboard(env),
          getRecent(env)
        ]);
        return json({
          ok: true,
          today: new Date().toISOString().slice(0, 10),
          categories,
          dashboard,
          recent
        }, 200, cors);
      }

      if (path === "/api/dashboard" && request.method === "GET") {
        return json({ ok: true, dashboard: await getDashboard(env) }, 200, cors);
      }

      if (path === "/api/recent" && request.method === "GET") {
        return json({ ok: true, recent: await getRecent(env) }, 200, cors);
      }

      if (path === "/api/categories" && request.method === "POST") {
        const body = await readJson(request);
        const name = clean(body.name, 80);
        if (!name) return json({ ok: false, error: "Category name is required." }, 400, cors);

        await env.DB.prepare(
          "INSERT OR IGNORE INTO categories (name) VALUES (?)"
        ).bind(name).run();

        return json({ ok: true, categories: await getCategories(env) }, 200, cors);
      }

      if (path === "/api/observations" && request.method === "POST") {
        const body = await readJson(request);
        validateObservation(body);

        const categoryId = Number(body.categoryId);
        const category = await env.DB.prepare(
          "SELECT id FROM categories WHERE id = ? AND is_active = 1"
        ).bind(categoryId).first();
        if (!category) return json({ ok: false, error: "Choose a valid category." }, 400, cors);

        await env.DB.prepare(`
          INSERT INTO observations (
            event_date, observer, category_id, trigger_text, worry_text, suds,
            dad_responses, family_responses, duration, reassurance,
            progress_text, notes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          body.eventDate,
          clean(body.observer, 50),
          categoryId,
          clean(body.trigger, 1000),
          clean(body.worry, 1000),
          Number(body.suds),
          JSON.stringify(arrayOfText(body.dadResponses, 20, 80)),
          JSON.stringify(arrayOfText(body.familyResponses, 20, 80)),
          clean(body.duration, 80),
          clean(body.reassurance, 80),
          clean(body.progress, 500),
          clean(body.notes, 1500)
        ).run();

        return json({
          ok: true,
          message: "Observation saved.",
          dashboard: await getDashboard(env)
        }, 201, cors);
      }

      if (path === "/api/wins" && request.method === "POST") {
        const body = await readJson(request);
        if (!validDate(body.eventDate)) return json({ ok: false, error: "Choose a valid date." }, 400, cors);
        const win = clean(body.win, 1000);
        if (!win) return json({ ok: false, error: "Describe the win or progress." }, 400, cors);

        let categoryId = null;
        if (body.categoryId !== "" && body.categoryId != null) {
          categoryId = Number(body.categoryId);
          if (!Number.isInteger(categoryId)) categoryId = null;
        }

        await env.DB.prepare(`
          INSERT INTO wins (event_date, observer, win_text, category_id)
          VALUES (?, ?, ?, ?)
        `).bind(
          body.eventDate,
          clean(body.observer, 50),
          win,
          categoryId
        ).run();

        return json({
          ok: true,
          message: "Win saved.",
          dashboard: await getDashboard(env)
        }, 201, cors);
      }

      return json({ ok: false, error: "Not found." }, 404, cors);
    } catch (error) {
      console.error(error);
      const status = error.message === "Incorrect family PIN." ? 401 : 500;
      return json({ ok: false, error: error.message || "Unexpected server error." }, status, cors);
    }
  }
};

function corsHeaders(origin, env) {
  const configured = String(env.ALLOWED_ORIGIN || "").trim();
  const allowed = configured
    ? origin === configured
    : ALLOWED_ORIGINS.includes(origin) || /\.github\.io$/.test(new URL(origin || "https://invalid.local").hostname);

  return {
    "Access-Control-Allow-Origin": allowed ? origin : "null",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Family-Pin",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    "Content-Type": "application/json; charset=utf-8"
  };
}

function requirePin(request, env) {
  const supplied = request.headers.get("X-Family-Pin") || "";
  if (supplied !== env.FAMILY_PIN) throw new Error("Incorrect family PIN.");
}

async function readJson(request) {
  const type = request.headers.get("Content-Type") || "";
  if (!type.includes("application/json")) throw new Error("Request must be JSON.");
  return request.json();
}

async function getCategories(env) {
  const result = await env.DB.prepare(
    "SELECT id, name FROM categories WHERE is_active = 1 ORDER BY name COLLATE NOCASE"
  ).all();
  return result.results || [];
}

async function getDashboard(env) {
  const today = new Date();
  const start = new Date(today);
  start.setUTCDate(today.getUTCDate() - today.getUTCDay());
  const startDate = start.toISOString().slice(0, 10);
  const todayDate = today.toISOString().slice(0, 10);

  const [summary, topTrigger, wins] = await env.DB.batch([
    env.DB.prepare(`
      SELECT
        COUNT(*) AS observation_count,
        ROUND(AVG(suds), 1) AS average_suds,
        ROUND(100.0 * AVG(CASE WHEN reassurance = 'Yes, repeatedly' THEN 1 ELSE 0 END), 0) AS reassurance_rate,
        SUM(CASE WHEN TRIM(COALESCE(progress_text,'')) <> '' THEN 1 ELSE 0 END) AS progress_count
      FROM observations
      WHERE event_date BETWEEN ? AND ?
    `).bind(startDate, todayDate),
    env.DB.prepare(`
      SELECT c.name, COUNT(*) AS total
      FROM observations o
      JOIN categories c ON c.id = o.category_id
      WHERE o.event_date BETWEEN ? AND ?
      GROUP BY c.id, c.name
      ORDER BY total DESC, c.name
      LIMIT 1
    `).bind(startDate, todayDate),
    env.DB.prepare(`
      SELECT COUNT(*) AS total
      FROM wins
      WHERE event_date BETWEEN ? AND ?
    `).bind(startDate, todayDate)
  ]);

  const s = summary.results?.[0] || {};
  const top = topTrigger.results?.[0] || {};
  const w = wins.results?.[0] || {};

  const observationCount = Number(s.observation_count || 0);
  const averageSuds = s.average_suds == null ? null : Number(s.average_suds);
  const reassuranceRate = observationCount ? Number(s.reassurance_rate || 0) : null;
  const progressCount = Number(s.progress_count || 0);
  const winsCount = Number(w.total || 0);
  const topName = top.name || "No data yet";

  let summaryText = "No observations have been recorded this week yet.";
  if (observationCount) {
    summaryText =
      `This week the family recorded ${observationCount} observation${observationCount === 1 ? "" : "s"}. ` +
      `${topName} was the most common trigger. ` +
      `${averageSuds == null ? "" : `Average SUDS was ${averageSuds}. `}` +
      `Repeated reassurance was recorded in ${reassuranceRate}% of observations. ` +
      `${winsCount} win${winsCount === 1 ? "" : "s"} ${winsCount === 1 ? "was" : "were"} recorded.`;
  }

  return {
    observationsThisWeek: observationCount,
    averageSuds,
    topTrigger: topName,
    repeatedReassuranceRate: reassuranceRate,
    progressEntriesThisWeek: progressCount,
    winsThisWeek: winsCount,
    summary: summaryText
  };
}

async function getRecent(env) {
  const result = await env.DB.prepare(`
    SELECT * FROM (
      SELECT
        'trigger' AS type,
        o.id,
        o.event_date AS eventDate,
        c.name AS category,
        o.trigger_text AS title,
        o.worry_text AS detail,
        o.suds AS suds,
        o.created_at AS createdAt
      FROM observations o
      JOIN categories c ON c.id = o.category_id

      UNION ALL

      SELECT
        'win' AS type,
        w.id,
        w.event_date AS eventDate,
        COALESCE(c.name, '') AS category,
        w.win_text AS title,
        '' AS detail,
        NULL AS suds,
        w.created_at AS createdAt
      FROM wins w
      LEFT JOIN categories c ON c.id = w.category_id
    )
    ORDER BY eventDate DESC, createdAt DESC
    LIMIT 20
  `).all();

  return result.results || [];
}

function validateObservation(body) {
  if (!validDate(body.eventDate)) throw new Error("Choose a valid date.");
  if (!Number.isInteger(Number(body.categoryId))) throw new Error("Choose a category.");
  if (!clean(body.trigger, 1000)) throw new Error("Briefly describe what happened.");
  if (!clean(body.worry, 1000)) throw new Error("Briefly describe Dad's worry.");
  const suds = Number(body.suds);
  if (!Number.isInteger(suds) || suds < 0 || suds > 10) throw new Error("Choose a SUDS score from 0 to 10.");
}

function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ""));
}

function clean(value, max = 1000) {
  return String(value == null ? "" : value).trim().slice(0, max);
}

function arrayOfText(value, maxItems, maxLength) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, maxItems).map(v => clean(v, maxLength)).filter(Boolean);
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), { status, headers });
}
