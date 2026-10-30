// How Kiori is used, week by week (Monday to Sunday, UTC), for the people running it: active and new projects, the
// calls they made, the model calls on their keys, failed calls, access requests, and how many projects are still
// active four weeks on. Counts from what the server keeps anyway (calls per endpoint and day, model calls, failed
// calls, projects, access requests); nothing about what was said.
import { all, one } from './db.mjs';

const DAY = 864e5;
const iso = t => new Date(t).toISOString().slice(0, 10);
const monday = t => { const d = new Date(t); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (d.getUTCDay() + 6) % 7); };
// The Monday of the week a day or a time falls in, in SQL
const week = col => `date(${col}, 'weekday 0', '-6 days')`;
const ROUTES = { brains: 'POST /v1/brains', recalls: 'POST /v1/brains/recall', learns: 'POST /v1/brains/organize', checks: 'POST /v1/brains/check', chats: 'POST /v1/chat/completions' };

// Customers' projects only (on their own brain API key) unless everyone: this server's own run on its key
export function weeklyStats({ weeks = 12, everyone = false } = {}) {
    const first = monday(Date.now()) - (weeks - 1) * 7 * DAY, since = iso(first);
    const scope = everyone ? '1' : "p.llm_mode = 'own'";
    const rows = new Map();
    for (let i = 0; i < weeks; i++) {
        const w = iso(first + i * 7 * DAY);
        rows.set(w, { week: w, active: 0, new_projects: 0, calls: 0, ...Object.fromEntries(Object.keys(ROUTES).map(k => [k, 0])), model_calls: 0, model_cost: 0, errors: 0, error_rate: 0, kept_4w: null, requests: 0, approved: 0 });
    }
    const add = (list, fill) => { for (const r of list) if (rows.has(r.week)) fill(rows.get(r.week), r); };

    add(all(`SELECT ${week('c.day')} AS week, COUNT(DISTINCT c.project_id) AS active, SUM(c.n) AS calls,
        ${Object.keys(ROUTES).map(k => `SUM(CASE WHEN c.route = ? THEN c.n ELSE 0 END) AS ${k}`).join(', ')}
        FROM calls c JOIN projects p ON p.id = c.project_id WHERE c.day >= ? AND ${scope} GROUP BY week`, ...Object.values(ROUTES), since),
    (w, r) => Object.assign(w, { active: r.active, calls: r.calls, ...Object.fromEntries(Object.keys(ROUTES).map(k => [k, r[k]])) }));
    add(all(`SELECT ${week('p.created_at')} AS week, COUNT(*) AS n FROM projects p WHERE p.created_at >= ? AND ${scope} GROUP BY week`, since),
        (w, r) => { w.new_projects = r.n; });
    add(all(`SELECT ${week('u.at')} AS week, COUNT(*) AS n, SUM(u.cost) AS cost FROM usage u LEFT JOIN projects p ON p.id = u.project_id WHERE u.at >= ? AND ${scope} GROUP BY week`, since),
        (w, r) => { w.model_calls = r.n; w.model_cost = Math.round((r.cost ?? 0) * 1e4) / 1e4; });
    add(all(`SELECT ${week('e.at')} AS week, COUNT(*) AS n FROM errors e LEFT JOIN projects p ON p.id = e.project_id WHERE e.at >= ? AND ${scope} GROUP BY week`, since),
        (w, r) => { w.errors = r.n; });
    add(all(`SELECT ${week('created_at')} AS week, COUNT(*) AS n, SUM(status = 'approved') AS approved FROM access_requests WHERE created_at >= ? GROUP BY week`, since),
        (w, r) => { w.requests = r.n; w.approved = r.approved; });

    // Of the projects active four weeks before, the share still active this week
    const activeIn = new Map();
    for (const r of all(`SELECT DISTINCT ${week('c.day')} AS week, c.project_id AS project FROM calls c JOIN projects p ON p.id = c.project_id WHERE c.day >= ? AND ${scope}`, iso(first - 28 * DAY))) {
        if (!activeIn.has(r.week)) activeIn.set(r.week, new Set());
        activeIn.get(r.week).add(r.project);
    }
    for (const w of rows.values()) {
        if (w.calls) w.error_rate = Math.round(w.errors / w.calls * 1e4) / 1e4;
        const before = activeIn.get(iso(Date.parse(w.week) - 28 * DAY)), now = activeIn.get(w.week) ?? new Set();
        if (before?.size) w.kept_4w = Math.round([...before].filter(p => now.has(p)).length / before.size * 100) / 100;
    }

    const totals = one(`SELECT COUNT(*) AS projects FROM projects p WHERE ${scope}`);
    const ever = one(`SELECT COALESCE(SUM(CASE WHEN c.route = ? THEN c.n END), 0) AS brains, COALESCE(SUM(CASE WHEN c.route = ? THEN c.n END), 0) AS learns
        FROM calls c JOIN projects p ON p.id = c.project_id WHERE ${scope}`, ROUTES.brains, ROUTES.learns);
    return { scope: everyone ? 'all' : 'customers', weeks: [...rows.values()], totals: { ...totals, ...ever } };
}
