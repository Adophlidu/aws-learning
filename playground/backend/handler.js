const mysql = require("mysql2/promise");
const { toRow } = require("./mapper");

const CORS_HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function resp(statusCode, body) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

async function getConn() {
  return mysql.createConnection({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: Number(process.env.DB_PORT || 3306),
    connectTimeout: 5000,
  });
}

async function fetchGithubProfile(token) {
  return fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "github-profile-collector",
    },
  });
}

async function createProfile(body) {
  const token = body && body.token;
  if (!token) return resp(400, { error: "token is required" });

  let res;
  try {
    res = await fetchGithubProfile(token);
  } catch (e) {
    return resp(502, { error: "github api error" });
  }
  if (res.status === 401) return resp(401, { error: "invalid github token" });
  if (!res.ok) return resp(502, { error: "github api error" });

  const profile = await res.json();
  const row = toRow(profile);

  const conn = await getConn();
  try {
    await conn.execute(
      `INSERT INTO profiles
        (github_id, login, name, avatar_url, bio, company, location,
         public_repos, followers, following, github_created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         login=VALUES(login), name=VALUES(name), avatar_url=VALUES(avatar_url),
         bio=VALUES(bio), company=VALUES(company), location=VALUES(location),
         public_repos=VALUES(public_repos), followers=VALUES(followers),
         following=VALUES(following), github_created_at=VALUES(github_created_at)`,
      [row.github_id, row.login, row.name, row.avatar_url, row.bio, row.company,
       row.location, row.public_repos, row.followers, row.following, row.github_created_at]
    );
    const [rows] = await conn.execute(
      "SELECT * FROM profiles WHERE github_id=?", [row.github_id]
    );
    return resp(201, rows[0]);
  } finally {
    await conn.end();
  }
}

async function listProfiles() {
  const conn = await getConn();
  try {
    const [rows] = await conn.execute(
      "SELECT id, login, name, avatar_url, public_repos, followers " +
      "FROM profiles ORDER BY id DESC"
    );
    return resp(200, rows);
  } finally {
    await conn.end();
  }
}

async function getProfile(id) {
  const conn = await getConn();
  try {
    const [rows] = await conn.execute("SELECT * FROM profiles WHERE id=?", [id]);
    if (rows.length === 0) return resp(404, { error: "profile not found" });
    return resp(200, rows[0]);
  } finally {
    await conn.end();
  }
}

exports.handler = async (event) => {
  const route = event.routeKey || "";
  if (route.startsWith("OPTIONS")) return resp(200, {});
  try {
    if (route === "POST /profiles") {
      const body = JSON.parse(event.body || "{}");
      return await createProfile(body);
    }
    if (route === "GET /profiles") return await listProfiles();
    if (route === "GET /profiles/{id}") {
      return await getProfile(event.pathParameters.id);
    }
    return resp(404, { error: "not found" });
  } catch (e) {
    return resp(500, { error: "internal error" });
  }
};
