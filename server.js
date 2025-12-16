import express from "express";
import cors from "cors";
import pg from "pg";
import dotenv from "dotenv";
import axios from "axios";

dotenv.config();

const { Pool } = pg;

// ------------------------------
// DATABASE
// ------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// ------------------------------
// INIT TABLES
// ------------------------------
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS marketplace_nfts (
      id SERIAL PRIMARY KEY,
      submission_id INTEGER,
      name TEXT,
      description TEXT,
      image_cid TEXT,
      metadata_cid TEXT,
      price_xrp TEXT,
      price_rlusd TEXT,
      creator_wallet TEXT,
      terms TEXT,
      website TEXT,
      quantity INTEGER,
      sold_count INTEGER DEFAULT 0,
      minted BOOLEAN DEFAULT true,
      sold BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}

async function initOrdersDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      marketplace_nft_id INTEGER NOT NULL,
      buyer_wallet TEXT NOT NULL,
      buyer_email TEXT,
      price NUMERIC(20,8) NOT NULL,
      currency TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'PAID',
      xumm_payload_uuid TEXT,
      tx_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS orders_unique_payload
    ON orders (xumm_payload_uuid)
    WHERE xumm_payload_uuid IS NOT NULL;
  `);

  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS orders_unique_tx
    ON orders (tx_hash)
    WHERE tx_hash IS NOT NULL;
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS orders_buyer_wallet_idx
    ON orders (buyer_wallet);
  `);
}

initDB();
initOrdersDB();

// ------------------------------
// HELPERS
// ------------------------------
function parsePrice(raw) {
  if (!raw) return NaN;
  if (typeof raw === "number") return raw;
  return Number(raw.replace(/[^0-9.]/g, ""));
}

// ------------------------------
// APP
// ------------------------------
const app = express();
app.use(express.json());
app.use(cors());

// ------------------------------
// TEST
// ------------------------------
app.get("/", (_, res) => {
  res.send("CFC Marketplace backend running");
});

// ------------------------------
// GET ALL NFTs
// ------------------------------
app.get("/api/market/all", async (_, res) => {
  const r = await pool.query(`
    SELECT *,
      GREATEST(COALESCE(quantity,0),0) AS quantity_remaining,
      (GREATEST(COALESCE(quantity,0),0)=0) AS sold_out
    FROM marketplace_nfts
    WHERE minted=true AND sold=false
    ORDER BY id DESC
  `);
  res.json(r.rows);
});

// ------------------------------
// CREATE PAYLOADS (UNCHANGED)
// ------------------------------
app.post("/api/market/pay-xrp", async (req, res) => {
  const { id } = req.body;
  const nft = await pool.query("SELECT * FROM marketplace_nfts WHERE id=$1", [id]);
  if (!nft.rows.length) return res.status(404).json({ error: "NFT not found" });

  const amount = parsePrice(nft.rows[0].price_xrp);
  const drops = String(amount * 1_000_000);

  const payload = {
    txjson: {
      TransactionType: "Payment",
      Destination: process.env.PAY_DESTINATION,
      Amount: drops
    },
    options: {
      submit: true,
      return_url: {
        web: "https://centerforcreators.com/nft-marketplace",
        app: "https://centerforcreators.com/nft-marketplace"
      }
    },
    custom_meta: { blob: { nft_id: id } }
  };

  const r = await axios.post("https://xumm.app/api/v1/platform/payload", payload, {
    headers: {
      "X-API-Key": process.env.XUMM_API_KEY,
      "X-API-Secret": process.env.XUMM_API_SECRET
    }
  });

  res.json({ link: r.data.next.always });
});

// ------------------------------
// WEBHOOK — CREATE ORDER THEN DECREMENT
// ------------------------------
app.post("/api/xaman/webhook", async (req, res) => {
  const client = await pool.connect();

  try {
    const p = req.body?.payload;

    if (p?.response?.dispatched_result !== "tesSUCCESS" || p?.meta?.signed !== true) {
      return res.json({ ok: true });
    }

    const nftId = p?.custom_meta?.blob?.nft_id;
    const buyerWallet = p?.response?.account;

    if (!nftId || !buyerWallet) {
      // HARD FAIL — no wallet, no order, no quantity change
      return res.json({ ok: true });
    }

    const txHash = p?.response?.txid;
    const payloadUUID = p?.payload_uuidv4;

    await client.query("BEGIN");

    const nftRes = await client.query(
      "SELECT * FROM marketplace_nfts WHERE id=$1 FOR UPDATE",
      [nftId]
    );

    if (!nftRes.rows.length || nftRes.rows[0].quantity <= 0) {
      await client.query("ROLLBACK");
      return res.json({ ok: true });
    }

    const nft = nftRes.rows[0];
    const currency = p?.response?.delivered_amount?.currency ? "RLUSD" : "XRP";
    const price =
      currency === "RLUSD"
        ? parsePrice(nft.price_rlusd)
        : parsePrice(nft.price_xrp);

    const inserted = await client.query(
      `
      INSERT INTO orders
        (marketplace_nft_id, buyer_wallet, price, currency, xumm_payload_uuid, tx_hash)
      VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT DO NOTHING
      RETURNING id
      `,
      [nftId, buyerWallet, price, currency, payloadUUID, txHash]
    );

    if (inserted.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.json({ ok: true });
    }

    await client.query(
      "UPDATE marketplace_nfts SET quantity=quantity-1, sold_count=sold_count+1 WHERE id=$1",
      [nftId]
    );

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "webhook failed" });
  } finally {
    client.release();
  }
});

// ------------------------------
// STEP 3.3 — GET ORDERS BY WALLET
// ------------------------------
app.get("/api/orders/by-wallet/:wallet", async (req, res) => {
  const { wallet } = req.params;

  const r = await pool.query(
    `
    SELECT o.*, n.name, n.image_cid
    FROM orders o
    JOIN marketplace_nfts n ON n.id = o.marketplace_nft_id
    WHERE o.buyer_wallet = $1
    ORDER BY o.created_at DESC
    `,
    [wallet]
  );

  res.json(r.rows);
});

// ------------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log("Marketplace backend running on port", PORT);
});
