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

// Create marketplace table if not exists
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
      website TEXT,               -- ✅ NEW (public)
      quantity INTEGER,
      sold_count INTEGER DEFAULT 0,
      minted BOOLEAN DEFAULT true,
      sold BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}
initDB();

// ✅ Step 3: ensure orders table exists (safe if already created)
async function initOrdersDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,

      marketplace_nft_id INTEGER NOT NULL,
      buyer_wallet TEXT NOT NULL,

      buyer_email TEXT NULL,

      price NUMERIC(20, 8) NOT NULL,
      currency TEXT NOT NULL, -- 'XRP' or 'RLUSD'

      status TEXT NOT NULL DEFAULT 'PAID', -- PAID | REDEEM_REQUESTED | FULFILLED

      xumm_payload_uuid TEXT NULL,
      tx_hash TEXT NULL,

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

  await pool.query(`
    CREATE INDEX IF NOT EXISTS orders_marketplace_nft_id_idx
    ON orders (marketplace_nft_id);
  `);
}
initOrdersDB();

// ------------------------------
// HELPER: safely parse prices
// ------------------------------
function parsePrice(raw) {
  if (raw === null || raw === undefined) return NaN;
  if (typeof raw === "number") return raw;

  if (typeof raw === "string") {
    const cleaned = raw.replace(/[^0-9.]/g, "");
    if (!cleaned) return NaN;
    return Number(cleaned);
  }
  return NaN;
}

// ------------------------------
// APP
// ------------------------------
const app = express();
app.use(express.json());
app.use(cors());

// ------------------------------
// TEST ROUTE
// ------------------------------
app.get("/", (req, res) => {
  res.send("CFC Marketplace backend is running");
});

// ------------------------------
// RECEIVE NFT FROM CREATOR BACKEND
// ------------------------------
app.post("/api/add-nft", async (req, res) => {
  try {
    const {
      submission_id,
      name,
      description,
      image_cid,
      metadata_cid,
      price_xrp,
      price_rlusd,
      creator_wallet,
      terms,
      website,            // ✅ NEW
      quantity
    } = req.body;

    await pool.query(
      `
      INSERT INTO marketplace_nfts
      (
        submission_id,
        name,
        description,
        image_cid,
        metadata_cid,
        price_xrp,
        price_rlusd,
        creator_wallet,
        terms,
        website,
        quantity,
        minted,
        sold
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,false)
      `,
      [
        submission_id,
        name,
        description,
        image_cid,
        metadata_cid,
        price_xrp,
        price_rlusd,
        creator_wallet,
        terms,
        website,
        quantity
      ]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("ADD NFT error:", err);
    res.status(500).json({ error: "Failed to add NFT" });
  }
});

// ------------------------------
// GET ALL MARKETPLACE NFTs
// ------------------------------
app.get("/api/market/all", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        *,
        GREATEST(COALESCE(quantity, 0), 0) AS quantity_remaining,
        (GREATEST(COALESCE(quantity, 0), 0) = 0) AS sold_out
      FROM marketplace_nfts
      WHERE minted = true AND sold = false
      ORDER BY id DESC
    `);

    res.json(result.rows);
  } catch (err) {
    console.error("NFT fetch error:", err);
    res.status(500).json({ error: "Failed to fetch NFTs" });
  }
});

// ------------------------------
// PAY XRP FOR NFT (CREATE PAYLOAD ONLY)
// ------------------------------
app.post("/api/market/pay-xrp", async (req, res) => {
  try {
    const { id } = req.body;

    const nft = await pool.query(
      "SELECT * FROM marketplace_nfts WHERE id=$1",
      [id]
    );

    if (!nft.rows.length) {
      return res.status(404).json({ error: "NFT not found" });
    }

    const item = nft.rows[0];
    const xrpAmount = parsePrice(item.price_xrp);

    if (!Number.isFinite(xrpAmount) || xrpAmount <= 0) {
      return res.status(400).json({ error: "Invalid XRP price" });
    }

    const drops = String(xrpAmount * 1_000_000);

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
      custom_meta: {
        blob: {
          nft_id: id
        }
      }
    };

    const r = await axios.post(
      "https://xumm.app/api/v1/platform/payload",
      payload,
      {
        headers: {
          "X-API-Key": process.env.XUMM_API_KEY,
          "X-API-Secret": process.env.XUMM_API_SECRET,
          "Content-Type": "application/json"
        }
      }
    );

    res.json({ link: r.data.next.always });
  } catch (err) {
    console.error("PAY XRP error:", err);
    res.status(500).json({ error: "Failed to create payment" });
  }
});

// ------------------------------
// PAY RLUSD FOR NFT (CREATE PAYLOAD ONLY)
// ------------------------------
app.post("/api/market/pay-rlusd", async (req, res) => {
  try {
    const { id } = req.body;

    const nft = await pool.query(
      "SELECT * FROM marketplace_nfts WHERE id=$1",
      [id]
    );

    if (!nft.rows.length) {
      return res.status(404).json({ error: "NFT not found" });
    }

    const item = nft.rows[0];
    const rlusdAmount = parsePrice(item.price_rlusd);

    if (!Number.isFinite(rlusdAmount) || rlusdAmount <= 0) {
      return res.status(400).json({ error: "Invalid RLUSD price" });
    }

    const payload = {
      txjson: {
        TransactionType: "Payment",
        Destination: process.env.PAY_DESTINATION,
        Amount: {
          currency: "524C555344000000000000000000000000000000",
          issuer: process.env.PAY_DESTINATION,
          value: String(rlusdAmount)
        }
      },
      options: {
        submit: true,
        return_url: {
          web: "https://centerforcreators.com/nft-marketplace",
          app: "https://centerforcreators.com/nft-marketplace"
        }
      },
      custom_meta: {
        blob: {
          nft_id: id
        }
      }
    };

    const r = await axios.post(
      "https://xumm.app/api/v1/platform/payload",
      payload,
      {
        headers: {
          "X-API-Key": process.env.XUMM_API_KEY,
          "X-API-Secret": process.env.XUMM_API_SECRET,
          "Content-Type": "application/json"
        }
      }
    );

    res.json({ link: r.data.next.always });
  } catch (err) {
    console.error("PAY RLUSD error:", err);
    res.status(500).json({ error: "Failed to create payment" });
  }
});

// ------------------------------
// ✅ XAMAN WEBHOOK — CONFIRMED PAYMENT ONLY
// RULE: create order FIRST, then decrement quantity
// ------------------------------
app.post("/api/xaman/webhook", async (req, res) => {
  const client = await pool.connect();

  try {
    const payload = req.body;

    // Only process SUCCESS + signed
    if (
      payload?.payload?.response?.dispatched_result !== "tesSUCCESS" ||
      payload?.payload?.meta?.signed !== true
    ) {
      return res.json({ ok: true });
    }

    const nftId = payload?.payload?.custom_meta?.blob?.nft_id;
    if (!nftId) return res.json({ ok: true });

    // Idempotency keys (prevent double handling)
    const xummPayloadUuid =
      payload?.payload?.payload_uuidv4 ||
      payload?.payload?.uuid ||
      payload?.payload_uuidv4 ||
      null;

    const txHash =
      payload?.payload?.response?.txid ||
      payload?.payload?.txid ||
      payload?.txid ||
      null;

    const buyerWallet =
      payload?.payload?.response?.account ||
      payload?.payload?.response?.Account ||
      payload?.payload?.meta?.account ||
      payload?.payload?.meta?.Account ||
      "UNKNOWN";

    await client.query("BEGIN");

    // Lock the NFT row so two webhooks can't decrement at once
    const nftRes = await client.query(
      "SELECT * FROM marketplace_nfts WHERE id = $1 FOR UPDATE",
      [nftId]
    );

    if (!nftRes.rows.length) {
      await client.query("ROLLBACK");
      return res.json({ ok: true });
    }

    const nft = nftRes.rows[0];
    const qty = Number(nft.quantity || 0);

    // If sold out, do nothing
    if (qty <= 0) {
      await client.query("ROLLBACK");
      return res.json({ ok: true });
    }

    // Determine currency + price for the order
    // (Prefer detecting token payment, otherwise XRP)
    let currency = "XRP";
    let price = parsePrice(nft.price_xrp);

    const deliveredAmount = payload?.payload?.response?.delivered_amount;

    if (deliveredAmount && typeof deliveredAmount === "object") {
      // RLUSD (or any issued token) payment payload
      currency = "RLUSD";
      price = parsePrice(nft.price_rlusd);
    }

    if (!Number.isFinite(price) || price <= 0) {
      // Safety: never decrement if we can't record a valid order
      await client.query("ROLLBACK");
      return res.json({ ok: true });
    }

    // 1) Create order FIRST (idempotent)
    // If webhook fires twice with same payload/tx, this insert will do nothing.
    const orderInsert = await client.query(
      `
      INSERT INTO orders
        (marketplace_nft_id, buyer_wallet, price, currency, status, xumm_payload_uuid, tx_hash)
      VALUES
        ($1, $2, $3, $4, 'PAID', $5, $6)
      ON CONFLICT DO NOTHING
      RETURNING id
      `,
      [nftId, buyerWallet, String(price), currency, xummPayloadUuid, txHash]
    );

    // If no row inserted, it means we already processed this payment.
    // IMPORTANT: do NOT decrement quantity again.
    if (orderInsert.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.json({ ok: true });
    }

    // 2) THEN decrement quantity + increment sold_count
    await client.query(
      `
      UPDATE marketplace_nfts
      SET sold_count = sold_count + 1,
          quantity = quantity - 1
      WHERE id = $1 AND quantity > 0
      `,
      [nftId]
    );

    await client.query("COMMIT");
    res.json({ ok: true });
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (e) {
      // ignore rollback errors
    }
    console.error("Webhook error:", err);
    res.status(500).json({ error: "Webhook failed" });
  } finally {
    client.release();
  }
});

// ------------------------------
// START SERVER
// ------------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log("Marketplace backend running on port", PORT);
});
