// Netlify serverless function. Holds the Anthropic API key server-side and
// proxies pitch-drafting requests from the browser.
//
// Required environment variables (set in Netlify > Site settings > Environment variables):
//   ANTHROPIC_API_KEY  -- your Anthropic API key
//   APP_PASSWORD       -- the password the app will require to unlock

exports.handler = async function(event) {
  // CORS / preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type, x-app-password",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const appPassword = process.env.APP_PASSWORD;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!appPassword || !apiKey) {
    return { statusCode: 500, body: "Server is missing APP_PASSWORD or ANTHROPIC_API_KEY environment variables." };
  }

  const incomingPassword = event.headers["x-app-password"] || event.headers["X-App-Password"];
  if (incomingPassword !== appPassword) {
    return { statusCode: 401, body: "Unauthorized" };
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch (e) {
    return { statusCode: 400, body: "Invalid JSON" };
  }

  // The login screen sends { ping: true } just to verify the password.
  if (body.ping) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true }),
    };
  }

  const prompt = body.prompt;
  if (!prompt || typeof prompt !== "string") {
    return { statusCode: 400, body: "Missing prompt" };
  }

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return {
        statusCode: response.status,
        body: "Anthropic API error: " + errText,
      };
    }

    const data = await response.json();
    const text = (data.content || []).map(function(b) { return b.text || ""; }).join("");

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: text }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: "Request failed: " + (err && err.message ? err.message : String(err)),
    };
  }
};
