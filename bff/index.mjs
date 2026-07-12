// BFF：POST /profiles 编排两个服务；其余转发到内网 ALB（ALB 按路径分流）
const ALB = process.env.ALB_URL; // http://internal-...elb.amazonaws.com

async function call(method, path, body) {
  const init = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${ALB}${path}`, init);
  const text = await res.text();
  return { status: res.status, text };
}

const CORS = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
};

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || "GET";
  const path = event.rawPath || "/";
  const qs = event.rawQueryString ? `?${event.rawQueryString}` : "";

  try {
    // 编排：创建 profile 时，先存档、再采集 repos
    if (method === "POST" && path === "/profiles") {
      const body = JSON.parse(event.body || "{}");
      const p = await call("POST", "/profiles", { token: body.token });
      if (p.status !== 201) return { statusCode: p.status, headers: CORS, body: p.text };
      const profile = JSON.parse(p.text);
      // fire stats collection（失败不阻断创建）
      try {
        await call("POST", "/collect", { token: body.token, github_id: profile.github_id });
      } catch (_) {}
      return { statusCode: 201, headers: CORS, body: JSON.stringify(profile) };
    }
    // 其余：原样转发（ALB 按路径路由到 profile / stats）
    const r = await call(method, path + qs, event.body ? JSON.parse(event.body) : undefined);
    return { statusCode: r.status, headers: CORS, body: r.text };
  } catch (e) {
    return { statusCode: 502, headers: CORS, body: JSON.stringify({ error: "bff error" }) };
  }
};
