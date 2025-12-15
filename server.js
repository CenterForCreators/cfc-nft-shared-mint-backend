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
// ------------------------------
app.post("/api/xaman/webhook", async (req, res) => {
  try {
    const payload = req.body;

    if (
      payload?.payload?.response?.dispatched_result !== "tesSUCCESS" ||
      payload?.payload?.meta?.signed !== true
    ) {
      return res.json({ ok: true });
    }

    const nftId = payload?.payload?.custom_meta?.blob?.nft_id;
    if (!nftId) return res.json({ ok: true });

    await pool.query(
      `
      UPDATE marketplace_nfts
      SET sold_count = sold_count + 1,
          quantity = quantity - 1
      WHERE id = $1 AND quantity > 0
      `,
      [nftId]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).json({ error: "Webhook failed" });
  }
});

// ------------------------------
// START SERVER
// ------------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log("Marketplace backend running on port", PORT);
});
