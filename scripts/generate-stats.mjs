#!/usr/bin/env node
/**
 * Self-hosted GitHub contribution stats generator.
 *
 * - Reads GH_USERNAME and GH_TOKEN from the environment.
 * - Pages GitHub's GraphQL `contributionsCollection.contributionCalendar`
 *   in <=1-year windows from the account's `createdAt` to now, merges all
 *   days into one sorted list of { date, contributionCount }.
 * - Computes total contributions, current streak, and longest streak.
 * - Renders two self-contained dark-theme SVGs (no external fonts/images):
 *     assets/streak.svg   — total / current (circular badge) / longest
 *     assets/activity.svg — line/area chart of the last 31 days
 *
 * Node 20+, no npm dependencies (uses built-in fetch).
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API_URL = "https://api.github.com/graphql";
// Keep each window strictly under one year so the API never rejects it.
const WINDOW_DAYS = 364;
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

const USERNAME = (process.env.GH_USERNAME ?? "").trim();
const TOKEN = (process.env.GH_TOKEN ?? "").trim();

if (!USERNAME) {
  console.error("error: GH_USERNAME environment variable is required");
  process.exit(1);
}
if (!TOKEN) {
  console.error("error: GH_TOKEN environment variable is required");
  process.exit(1);
}

async function gql(query, variables) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "rswlljms-stats-generator",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    throw new Error(`GitHub API HTTP ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`GitHub API errors: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

async function fetchCreatedAt(login) {
  const data = await gql(
    `query UserCreatedAt($login: String!) {
       user(login: $login) { createdAt }
     }`,
    { login },
  );
  const createdAt = data?.user?.createdAt;
  if (!createdAt) throw new Error(`Could not find user "${login}" (check GH_USERNAME).`);
  return createdAt;
}

async function fetchWindow(login, fromISO, toISO) {
  const data = await gql(
    `query CalendarWindow($login: String!, $from: DateTime, $to: DateTime) {
       user(login: $login) {
         contributionsCollection(from: $from, to: $to) {
           contributionCalendar {
             totalContributions
             weeks {
               contributionDays { date contributionCount }
             }
           }
         }
       }
     }`,
    { login, from: fromISO, to: toISO },
  );
  const calendar = data?.user?.contributionsCollection?.contributionCalendar;
  if (!calendar) throw new Error("Missing contributionCalendar in API response.");
  const days = [];
  for (const week of calendar.weeks ?? []) {
    for (const day of week.contributionDays ?? []) {
      days.push({ date: day.date, contributionCount: day.contributionCount });
    }
  }
  return days;
}

function toISODate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(`${iso}T00:00:00Z`);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

function formatRange(start, end) {
  if (!start || !end) return "No contributions yet";
  if (start === end) return formatDate(start);
  return `${formatDate(start)} – ${formatDate(end)}`;
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif`;

function renderStreakSVG({ username, total, totalStart, totalEnd, current, longest, generatedAt }) {
  const title = `${escapeXml(username)}'s Contribution Streak`;
  const col = (x, value, label, range) => `
      <text x="${x}" y="108" text-anchor="middle" font-family="${FONT}" font-size="30" font-weight="700" fill="#ffffff">${escapeXml(String(value))}</text>
      <text x="${x}" y="130" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" letter-spacing="0.6" fill="#9aa0b4">${escapeXml(label)}</text>
      <text x="${x}" y="146" text-anchor="middle" font-family="${FONT}" font-size="9" fill="#7a7f99">${escapeXml(range)}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="495" height="195" viewBox="0 0 495 195" role="img">
  <title>${title}</title>
  <rect x="0.5" y="0.5" width="494" height="194" rx="10" fill="#1a1b27" stroke="#38bdf8" stroke-opacity="0.4"/>
  <text x="25" y="34" font-family="${FONT}" font-size="15" font-weight="700" fill="#38bdf8">${title}</text>
  <line x1="165" y1="55" x2="165" y2="160" stroke="#2b2f45" stroke-width="1"/>
  <line x1="330" y1="55" x2="330" y2="160" stroke="#2b2f45" stroke-width="1"/>
  <circle cx="247.5" cy="96" r="33" fill="none" stroke="#38bdf8" stroke-width="2.5" stroke-opacity="0.85"/>
  <circle cx="247.5" cy="96" r="39" fill="none" stroke="#38bdf8" stroke-width="1" stroke-opacity="0.25"/>${col(82.5, `${total}`, "Total Contributions", formatRange(totalStart, totalEnd))}${col(247.5, `${current.length} day${current.length === 1 ? "" : "s"}`, "Current Streak", current.length > 0 ? formatRange(current.start, current.end) : "No active streak")}${col(412.5, `${longest.length} day${longest.length === 1 ? "" : "s"}`, "Longest Streak", longest.length > 0 ? formatRange(longest.start, longest.end) : "No contributions yet")}
  <text x="25" y="180" font-family="${FONT}" font-size="9" fill="#5b6078">Generated ${escapeXml(generatedAt)} (UTC) · source: GitHub GraphQL</text>
</svg>
`;
}

function buildSmoothPath(pts) {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
  if (pts.length === 2) {
    return `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)} L ${pts[1].x.toFixed(2)} ${pts[1].y.toFixed(2)}`;
  }
  let d = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

function renderActivitySVG({ username, last31, generatedAt }) {
  const W = 800;
  const H = 280;
  const padL = 48;
  const padR = 20;
  const padT = 66;
  const padB = 38;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const total = last31.reduce((a, d) => a + d.contributionCount, 0);
  const max = Math.max(1, ...last31.map((d) => d.contributionCount));
  const n = last31.length;
  const x = (i) => padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v) => padT + plotH - (v / max) * plotH;
  const pts = last31.map((d, i) => ({ x: x(i), y: y(d.contributionCount) }));
  const line = buildSmoothPath(pts);
  const area = `${line} L ${pts[n - 1].x.toFixed(2)} ${(padT + plotH).toFixed(2)} L ${pts[0].x.toFixed(2)} ${(padT + plotH).toFixed(2)} Z`;
  const gridVals = max <= 4 ? [...Array(max + 1).keys()] : [0, Math.round(max / 2), max];
  const grid = gridVals
    .map(
      (v) => `
    <line x1="${padL}" y1="${y(v).toFixed(1)}" x2="${W - padR}" y2="${y(v).toFixed(1)}" stroke="#2b2f45" stroke-width="1" stroke-dasharray="${v === 0 ? "none" : "4 4"}"/>
    <text x="${padL - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" font-family="${FONT}" font-size="10" fill="#7a7f99">${v}</text>`,
    )
    .join("");
  const dots = pts
    .map((p, i) => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="2.6" fill="#1a1b27" stroke="#38bdf8" stroke-width="1.6"><title>${escapeXml(last31[i].date)}: ${last31[i].contributionCount}</title></circle>`)
    .join("\n    ");
  const first = last31[0]?.date ?? "—";
  const mid = last31[Math.floor((n - 1) / 2)]?.date ?? "—";
  const last = last31[n - 1]?.date ?? "—";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img">
  <title>${escapeXml(username)}'s contribution activity — last 31 days</title>
  <defs>
    <linearGradient id="areaFill" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.45"/>
      <stop offset="100%" stop-color="#38bdf8" stop-opacity="0.04"/>
    </linearGradient>
  </defs>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10" fill="#1a1b27" stroke="#38bdf8" stroke-opacity="0.4"/>
  <text x="24" y="32" font-family="${FONT}" font-size="15" font-weight="700" fill="#38bdf8">${escapeXml(username)}'s Contribution Activity</text>
  <text x="24" y="50" font-family="${FONT}" font-size="11" fill="#9aa0b4">Last 31 days · ${total} contribution${total === 1 ? "" : "s"} · peak ${max}/day</text>
  ${grid}
  <path d="${area}" fill="url(#areaFill)"/>
  <path d="${line}" fill="none" stroke="#38bdf8" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>
  ${dots}
  <text x="${padL}" y="${H - 14}" font-family="${FONT}" font-size="10" fill="#7a7f99">${escapeXml(formatDate(first))}</text>
  <text x="${W / 2}" y="${H - 14}" text-anchor="middle" font-family="${FONT}" font-size="10" fill="#7a7f99">${escapeXml(formatDate(mid))}</text>
  <text x="${W - padR}" y="${H - 14}" text-anchor="end" font-family="${FONT}" font-size="10" fill="#7a7f99">${escapeXml(formatDate(last))}</text>
</svg>
`;
}

async function main() {
  const createdAt = await fetchCreatedAt(USERNAME);
  const startMs = Date.parse(createdAt);
  const nowMs = Date.now();
  const byDate = new Map();

  // Page through history in <=1-year windows (API rejects longer ranges).
  let windowStart = startMs;
  while (windowStart < nowMs) {
    const windowEnd = Math.min(windowStart + WINDOW_DAYS * DAY_MS, nowMs);
    const days = await fetchWindow(
      USERNAME,
      new Date(windowStart).toISOString(),
      new Date(windowEnd).toISOString(),
    );
    for (const d of days) byDate.set(d.date, d.contributionCount);
    if (windowEnd >= nowMs) break;
    windowStart = windowEnd + 1000; // step forward; Map merge dedupes any overlap
  }

  const sorted = [...byDate.entries()]
    .map(([date, contributionCount]) => ({ date, contributionCount }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const total = sorted.reduce((a, d) => a + d.contributionCount, 0);

  // Longest streak ever (requires consecutive calendar days with count > 0).
  let longest = { length: 0, start: null, end: null };
  let runLen = 0;
  let runStart = null;
  let prevMs = null;
  for (const day of sorted) {
    const ms = Date.parse(`${day.date}T00:00:00Z`);
    const consecutive = prevMs !== null && ms - prevMs === DAY_MS;
    if (day.contributionCount > 0 && (runLen === 0 || consecutive)) {
      if (runLen === 0) runStart = day.date;
      runLen += 1;
    } else if (day.contributionCount > 0) {
      runLen = 1;
      runStart = day.date;
    } else {
      runLen = 0;
      runStart = null;
    }
    if (runLen > longest.length) {
      longest = { length: runLen, start: runStart, end: day.date };
    }
    prevMs = ms;
  }

  // Current streak: consecutive active days ending today,
  // or ending yesterday if today is still at 0.
  const todayStr = toISODate(nowMs);
  const yesterdayStr = toISODate(nowMs - DAY_MS);
  const countFor = (dateStr) => byDate.get(dateStr) ?? 0;
  let anchor = null;
  if (countFor(todayStr) > 0) anchor = todayStr;
  else if (countFor(yesterdayStr) > 0) anchor = yesterdayStr;
  let current = { length: 0, start: null, end: null };
  if (anchor) {
    let cursorMs = Date.parse(`${anchor}T00:00:00Z`);
    let len = 0;
    while (countFor(toISODate(cursorMs)) > 0) {
      len += 1;
      cursorMs -= DAY_MS;
    }
    current = { length: len, start: toISODate(cursorMs + DAY_MS), end: anchor };
  }

  const last31 = sorted.slice(-31);
  const generatedAt = new Date(nowMs).toISOString().replace("T", " ").slice(0, 16);
  const streakSVG = renderStreakSVG({
    username: USERNAME,
    total,
    totalStart: sorted[0]?.date ?? null,
    totalEnd: sorted[sorted.length - 1]?.date ?? null,
    current,
    longest,
    generatedAt,
  });
  const activitySVG = renderActivitySVG({ username: USERNAME, last31, generatedAt });

  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, "..");
  const assetsDir = path.join(repoRoot, "assets");
  await mkdir(assetsDir, { recursive: true });
  await writeFile(path.join(assetsDir, "streak.svg"), streakSVG, "utf8");
  await writeFile(path.join(assetsDir, "activity.svg"), activitySVG, "utf8");

  console.log(
    `Wrote assets/streak.svg and assets/activity.svg for ${USERNAME}: ` +
      `total=${total}, current=${current.length} (${formatRange(current.start, current.end)}), ` +
      `longest=${longest.length} (${formatRange(longest.start, longest.end)}), days=${sorted.length}.`,
  );
}

await main();
