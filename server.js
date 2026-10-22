import express from "express";
import fetch from "node-fetch";
import crypto from "crypto";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3001;
const API_VERSION = process.env.SF_API_VERSION || "v66.0";
const QUOTE_STAGE = process.env.QUOTE_STAGE || "Qualification";
const BRAND_NAME = process.env.BRAND_NAME || "Headless 360";

// ---------------------------------------------------------------------------
// Product catalog shown on the quote form. Prices live here so the customer
// sees an estimate instantly; Salesforce receives the list value as Amount.
// ---------------------------------------------------------------------------
const CATALOG = [
  { id: "ls400", name: "LS-400 line sensor", unit: "per sensor", price: 340, margin: 44 },
  { id: "vm8", name: "VM-8 vibration monitor", unit: "per monitor", price: 780, margin: 41 },
  { id: "g2", name: "Edge Gateway G2", unit: "per gateway", price: 2900, margin: 36 },
  { id: "pac", name: "Plant automation controller", unit: "per controller", price: 12500, margin: 32 },
];
const DISCOUNT_OPTIONS = [0, 5, 10, 15];

// ---------------------------------------------------------------------------
// Salesforce auth (client credentials flow, runs as the app's integration user)
// ---------------------------------------------------------------------------
let cachedToken = null;
let tokenExpiry = 0;

async function getAccessToken(force = false) {
  if (!force && cachedToken && Date.now() < tokenExpiry) return cachedToken;

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
    throw new Error(`Salesforce auth failed: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + 14 * 60 * 1000;
  return cachedToken;
}

// Calls the Salesforce REST API, retrying once if the token has expired.
async function sf(pathAndQuery, options = {}, retried = false) {
  const token = await getAccessToken(retried);
  const res = await fetch(`${process.env.SF_INSTANCE_URL}/services/data/${API_VERSION}${pathAndQuery}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (res.status === 401 && !retried) return sf(pathAndQuery, options, true);
  if (res.status === 204) return null;

  const body = await res.json().catch(() => null);
  if (!res.ok) {
    // Salesforce returns [{ message, errorCode, fields }]. Validation rule
    // messages arrive here and are passed through to the customer.
    const first = Array.isArray(body) ? body[0] : body;
    const err = new Error(first?.message || `Salesforce error ${res.status}`);
    err.status = res.status;
    err.code = first?.errorCode;
    throw err;
  }
  return body;
}

const soql = (q) => sf(`/query?q=${encodeURIComponent(q)}`);
const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");

// ---------------------------------------------------------------------------
// Customer sessions. The browser never sends an account Id: every query is
// scoped server-side to the account of the contact who signed in.
// ---------------------------------------------------------------------------
const sessions = new Map();
const SESSION_COOKIE = "portal_session";

function sessionIdFrom(req) {
  const match = (req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([a-f0-9]+)`));
  return match ? match[1] : null;
}

function requireSession(req, res, next) {
  const session = sessions.get(sessionIdFrom(req));
  if (!session) return res.status(401).json({ error: "Sign in to continue." });
  req.session = session;
  next();
}

function publicSession(s) {
  return { firstName: s.firstName, name: s.contactName, email: s.email, company: s.accountName, brand: BRAND_NAME };
}

app.get("/api/brand", (req, res) => res.json({ brand: BRAND_NAME }));

app.post("/api/session", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!email || !email.includes("@")) {
    return res.status(400).json({ error: "Enter the email address you use with us." });
  }
  try {
    const result = await soql(
      "SELECT Id, FirstName, Name, Email, AccountId, Account.Name FROM Contact " +
        `WHERE Email = '${esc(email)}' AND AccountId != null LIMIT 1`
    );
    const contact = result.records[0];
    if (!contact) {
      return res.status(404).json({ error: "No account uses that email. Check the address and try again." });
    }

    const id = crypto.randomBytes(24).toString("hex");
    const session = {
      contactId: contact.Id,
      firstName: contact.FirstName || contact.Name,
      contactName: contact.Name,
      email: contact.Email,
      accountId: contact.AccountId,
      accountName: contact.Account.Name,
    };
    sessions.set(id, session);
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800${secure}`);
    res.json(publicSession(session));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Sign-in is unavailable right now. Try again in a moment." });
  }
});

app.get("/api/session", requireSession, (req, res) => res.json(publicSession(req.session)));

app.delete("/api/session", (req, res) => {
  sessions.delete(sessionIdFrom(req));
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0`);
  res.status(204).end();
});

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------
app.get("/api/catalog", requireSession, (req, res) => {
  res.json({ products: CATALOG.map(({ margin, ...p }) => p), discounts: DISCOUNT_OPTIONS });
});

// ---------------------------------------------------------------------------
// Quote requests (Opportunities created from this portal)
// ---------------------------------------------------------------------------
const REQUEST_FIELDS = "Id, Name, StageName, Amount, Discount_Percent__c, CloseDate, CreatedDate, IsClosed, IsWon";

app.get("/api/requests", requireSession, async (req, res) => {
  const where =
    `WHERE AccountId = '${esc(req.session.accountId)}' AND Name LIKE 'QR-%' ` + "ORDER BY CreatedDate DESC LIMIT 25";
  try {
    let result;
    try {
      // Includes the latest approval status when the integration user can see it.
      result = await soql(
        `SELECT ${REQUEST_FIELDS}, (SELECT Status FROM ProcessInstances ORDER BY CreatedDate DESC LIMIT 1) ` +
          `FROM Opportunity ${where}`
      );
    } catch {
      result = await soql(`SELECT ${REQUEST_FIELDS} FROM Opportunity ${where}`);
    }
    res.json(result.records.map(toCustomerRequest));
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Your quote requests couldn't be loaded. Refresh the page to try again." });
  }
});

app.post("/api/requests", requireSession, async (req, res) => {
  const { productId, quantity, discount, neededBy, notes } = req.body || {};
  const product = CATALOG.find((p) => p.id === productId);
  const qty = Number(quantity);
  const disc = Number(discount || 0);

  if (!product) return res.status(400).json({ error: "Choose a product to quote." });
  if (!Number.isInteger(qty) || qty < 1) return res.status(400).json({ error: "Enter a quantity of 1 or more." });
  if (!DISCOUNT_OPTIONS.includes(disc)) return res.status(400).json({ error: "Choose a discount from the list." });

  const s = req.session;
  const reference = `QR-${String(Date.now()).slice(-5)}`;
  const closeDate = isValidDate(neededBy) ? neededBy : addDays(new Date(), 30);
  const listValue = qty * product.price;

  const description = [
    `Quote request ${reference} submitted through the customer portal by ${s.contactName} (${s.email}).`,
    `${qty} × ${product.name} at ${money(product.price)} ${product.unit} = ${money(listValue)} list.`,
    disc ? `Customer requested a ${disc}% discount.` : "No discount requested.",
    notes ? `Customer notes: ${String(notes).slice(0, 2000)}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const created = await sf("/sobjects/Opportunity", {
      method: "POST",
      body: JSON.stringify({
        Name: `${reference} – ${s.accountName} – ${product.name}`,
        AccountId: s.accountId,
        StageName: QUOTE_STAGE,
        CloseDate: closeDate,
        Amount: listValue,
        Discount_Percent__c: disc,
        Margin_Percent__c: Math.max(product.margin - disc, 0),
        LeadSource: "Web",
        NextStep: `Prepare quote for ${s.contactName}`,
        Description: description,
      }),
    });

    // Link the requesting customer to the deal so the rep sees who asked.
    try {
      await sf("/sobjects/OpportunityContactRole", {
        method: "POST",
        body: JSON.stringify({ OpportunityId: created.id, ContactId: s.contactId, Role: "Decision Maker", IsPrimary: true }),
      });
    } catch (roleErr) {
      console.warn("Contact role not added:", roleErr.message);
    }

    res.status(201).json({ reference });
  } catch (err) {
    console.error(err);
    const isRule = ["FIELD_CUSTOM_VALIDATION_EXCEPTION", "REQUIRED_FIELD_MISSING", "FIELD_INTEGRITY_EXCEPTION"].includes(
      err.code
    );
    res
      .status(isRule ? 422 : 502)
      .json({ error: isRule ? err.message : "Your request couldn't be submitted. Try again in a moment." });
  }
});

// Translates Salesforce stages and approvals into the customer's language.
function toCustomerRequest(o) {
  const approval = o.ProcessInstances?.records?.[0]?.Status || null;
  const quoteStages = ["Proposal/Price Quote", "Negotiation/Review"];
  let status = "submitted";
  if (o.IsClosed) status = o.IsWon ? "ordered" : "closed";
  else if (quoteStages.includes(o.StageName)) status = "quote_sent";
  else if (approval === "Approved") status = "approved";
  else if (approval === "Rejected") status = "needs_discussion";
  else if (approval === "Pending") status = "in_review";

  const [reference, , ...productParts] = o.Name.split(" – ");
  return {
    reference,
    product: productParts.join(" – ") || o.Name,
    status,
    listValue: o.Amount,
    discount: o.Discount_Percent__c || 0,
    neededBy: o.CloseDate,
    submittedAt: o.CreatedDate,
  };
}

// ---------------------------------------------------------------------------
// Support cases for the signed-in customer's account
// ---------------------------------------------------------------------------
app.get("/api/cases", requireSession, async (req, res) => {
  try {
    const result = await soql(
      "SELECT CaseNumber, Subject, Status, Priority, IsClosed, LastModifiedDate FROM Case " +
        `WHERE AccountId = '${esc(req.session.accountId)}' ORDER BY IsClosed ASC, LastModifiedDate DESC LIMIT 20`
    );
    res.json(
      result.records.map((c) => ({
        number: c.CaseNumber,
        subject: c.Subject,
        status: c.Status,
        priority: c.Priority,
        isClosed: c.IsClosed,
        updatedAt: c.LastModifiedDate,
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(502).json({ error: "Your support cases couldn't be loaded. Refresh the page to try again." });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isValidDate(v) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x.toISOString().slice(0, 10);
}
function money(n) {
  return `$${Number(n).toLocaleString("en-US")}`;
}

// ---------------------------------------------------------------------------
// Static frontend
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
