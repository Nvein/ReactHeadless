import express from "express";
import fetch from "node-fetch";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3001;

// ---- Salesforce auth (client credentials flow) ----
let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

  const res = await fetch(`${process.env.SF_LOGIN_URL}/services/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: process.env.SF_CLIENT_ID,
      client_secret: process.env.SF_CLIENT_SECRET,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Salesforce auth failed: ${res.status} ${errText}`);
  }

  const data = await res.json();
  cachedToken = data.access_token;
  // refresh a bit before actual expiry
  tokenExpiry = Date.now() + 14 * 60 * 1000;
  return cachedToken;
}

// ---- API: open + closed opportunities ----
app.get("/api/opportunities", async (req, res) => {
  try {
    const token = await getAccessToken();
    const q =
      "SELECT Id, Name, StageName, Amount, CloseDate, IsClosed, IsWon, " +
      "Account.Name, Account.Industry FROM Opportunity ORDER BY CloseDate ASC";

    const sfRes = await fetch(
      `${process.env.SF_INSTANCE_URL}/services/data/v67.0/query?q=${encodeURIComponent(q)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!sfRes.ok) {
      const errText = await sfRes.text();
      return res.status(sfRes.status).json({ error: errText });
    }

    const data = await sfRes.json();
    res.json(data.records);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---- Serve the built/static frontend ----
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
