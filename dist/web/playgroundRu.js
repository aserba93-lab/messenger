export function renderPlaygroundRuHtml() {
    return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>GraphQL Playground (RU)</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 0; background: #0f172a; color: #e2e8f0; }
    .wrap { max-width: 1100px; margin: 0 auto; padding: 16px; }
    h1 { margin: 0 0 8px; font-size: 24px; }
    .muted { color: #94a3b8; margin-bottom: 14px; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .card { background: #111827; border: 1px solid #334155; border-radius: 10px; padding: 14px; }
    .step { font-size: 18px; margin-bottom: 8px; }
    label { display: block; margin: 8px 0 4px; font-size: 14px; color: #cbd5e1; }
    input, textarea { width: 100%; box-sizing: border-box; padding: 10px; border-radius: 8px; border: 1px solid #334155; background: #0b1220; color: #e2e8f0; }
    textarea { min-height: 210px; font-family: Consolas, monospace; }
    button { margin-top: 10px; padding: 10px 14px; border-radius: 8px; border: none; background: #2563eb; color: white; cursor: pointer; font-size: 14px; }
    button.secondary { background: #334155; }
    button.success { background: #0f766e; }
    pre { background: #020617; border: 1px solid #334155; border-radius: 8px; padding: 12px; overflow: auto; min-height: 210px; }
    .templates button { margin-right: 8px; margin-top: 0; }
    .quick-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
    @media (max-width: 900px) { .row { grid-template-columns: 1fr; } .quick-grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Проверка API (простой режим)</h1>
    <div class="muted">Шаги: 1) Войти через HTTP, 2) Получить токен, 3) Выполнять GraphQL запросы.</div>

    <div class="card">
      <div class="step">Шаг 1. Быстрый вход (HTTP /auth/login)</div>
      <div class="quick-grid">
        <div>
          <label>Email</label>
          <input id="httpEmail" value="admin@seed.local" />
        </div>
        <div>
          <label>Пароль</label>
          <input id="httpPassword" value="SeedPass123!" />
        </div>
        <div>
          <label>Organization ID</label>
          <input id="httpOrgId" placeholder="Вставь organizationId" />
        </div>
      </div>
      <button class="secondary" onclick="fillSeedInfo()">Заполнить seed ID автоматически</button>
      <button class="success" onclick="httpLogin()">Войти и получить accessToken</button>
      <pre id="httpResult">Нажми кнопку входа.</pre>
    </div>

    <div class="card" style="margin-top:12px;">
      <div class="step">Шаг 2. Токен для GraphQL</div>
      <label>Access Token (Bearer)</label>
      <input id="token" placeholder="Вставь accessToken или получи его кнопкой выше" />
      <div class="templates" style="margin-top:10px;">
        <button class="secondary" onclick="setTemplate('me')">Шаблон: me</button>
        <button class="secondary" onclick="setTemplate('messages')">Шаблон: messages</button>
        <button class="secondary" onclick="setTemplate('send')">Шаблон: sendMessage</button>
      </div>
    </div>

    <div class="row" style="margin-top: 12px;">
      <div class="card">
        <div class="step">Шаг 3. GraphQL запрос</div>
        <label>GraphQL запрос</label>
        <textarea id="query"></textarea>
        <label>Переменные (JSON)</label>
        <textarea id="variables">{}</textarea>
        <button onclick="runQuery()">Выполнить</button>
      </div>
      <div class="card">
        <label>Ответ</label>
        <pre id="result">{}</pre>
      </div>
    </div>
  </div>

  <script>
    const templates = {
      me: \`query { me { id email firstName lastName } }\`,
      messages: \`query Messages($channelId: ID!, $limit: Int!) {
  messages(channelId: $channelId, limit: $limit) {
    items { id content createdAt }
    nextCursor
  }
}\`,
      send: \`mutation Send($channelId: ID!, $content: String!) {
  sendMessage(input: {
    channelId: $channelId
    content: $content
  }) {
    id
    content
    createdAt
  }
}\`,
    };

    function setTemplate(name) {
      document.getElementById("query").value = templates[name] || "";
      if (name === "messages") {
        document.getElementById("variables").value = JSON.stringify({
          channelId: "PASTE_CHANNEL_ID",
          limit: 20
        }, null, 2);
      } else if (name === "me") {
        document.getElementById("variables").value = "{}";
      } else if (name === "send") {
        document.getElementById("variables").value = JSON.stringify({
          channelId: "PASTE_CHANNEL_ID",
          content: "Привет из playground-ru"
        }, null, 2);
      }
    }

    async function runQuery() {
      const query = document.getElementById("query").value;
      let variables = {};
      try {
        variables = JSON.parse(document.getElementById("variables").value || "{}");
      } catch (e) {
        document.getElementById("result").textContent = "Ошибка JSON в переменных";
        return;
      }

      const token = document.getElementById("token").value.trim();
      const headers = { "content-type": "application/json" };
      if (token) headers["authorization"] = "Bearer " + token;

      const res = await fetch("/graphql", {
        method: "POST",
        headers,
        body: JSON.stringify({ query, variables })
      });
      const data = await res.json();
      document.getElementById("result").textContent = JSON.stringify(data, null, 2);
    }

    async function httpLogin() {
      const email = document.getElementById("httpEmail").value.trim();
      const password = document.getElementById("httpPassword").value.trim();
      const organizationId = document.getElementById("httpOrgId").value.trim();
      if (!email || !password || !organizationId) {
        document.getElementById("httpResult").textContent = "Заполни email, пароль и organizationId";
        return;
      }
      const res = await fetch("/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, organizationId })
      });
      const data = await res.json();
      document.getElementById("httpResult").textContent = JSON.stringify(data, null, 2);
      if (data?.accessToken) {
        document.getElementById("token").value = data.accessToken;
      }
    }

    async function fillSeedInfo() {
      const res = await fetch("/playground-ru/seed-info");
      const data = await res.json();
      if (!res.ok) {
        document.getElementById("httpResult").textContent = JSON.stringify(data, null, 2);
        return;
      }
      document.getElementById("httpOrgId").value = data.organizationId || "";
      document.getElementById("httpEmail").value = data.adminEmail || "admin@seed.local";
      document.getElementById("httpPassword").value = data.adminPassword || "SeedPass123!";

      // Also prefill variables for templates where possible.
      const varsEl = document.getElementById("variables");
      try {
        const currentVars = JSON.parse(varsEl.value || "{}");
        if (data.channelId && Object.prototype.hasOwnProperty.call(currentVars, "channelId")) {
          currentVars.channelId = data.channelId;
          varsEl.value = JSON.stringify(currentVars, null, 2);
        }
      } catch {}

      document.getElementById("httpResult").textContent =
        "Seed данные подставлены. Нажми 'Войти и получить accessToken'.\\n\\n" +
        JSON.stringify(data, null, 2);
    }

    setTemplate("me");
  </script>
</body>
</html>`;
}
