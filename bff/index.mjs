// BFF：把 API Gateway 请求转发到内网 ALB 的 profile-service，不碰 DB
const ALB_URL = process.env.ALB_URL; // 形如 http://internal-...elb.amazonaws.com

export const handler = async (event) => {
  const method = event.requestContext?.http?.method || "GET";
  const path = event.rawPath || "/";
  const qs = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const url = `${ALB_URL}${path}${qs}`;

  const init = { method, headers: { "Content-Type": "application/json" } };
  if (event.body) init.body = event.body;

  try {
    const res = await fetch(url, init);
    const text = await res.text();
    return {
      statusCode: res.status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
      },
      body: text,
    };
  } catch (e) {
    return { statusCode: 502, body: JSON.stringify({ error: "bff upstream error" }) };
  }
};
