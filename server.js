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
      quantity INTEGER,
      minted BOOLEAN DEFAULT true,
      sold BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
}
initDB();

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
      quantity
    } = req.body;

    await pool.query(
      `
      INSERT INTO marketplace_nfts
      (submission_id, name, description, image_cid, metadata_cid,
       price_xrp, price_rlusd, creator_wallet, terms, quantity,
       minted, sold)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,false)
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
    const result = await pool.query(
      "SELECT * FROM marketplace_nfts WHERE minted = true AND sold = false ORDER BY id DESC"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("NFT fetch error:", err);
    res.status(500).json({ error: "Failed to fetch NFTs" });
  }
});

// ------------------------------
// PAY XRP FOR NFT (REAL PRICE + VALIDATION + REDIRECT)
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

    // ✅ FIX #1 — validate XRP price before continuing
    if (!item.price_xrp || isNaN(Number(item.price_xrp))) {
      return res.status(400).json({ error: "Invalid XRP price" });
    }

    const xrpAmount = Number(item.price_xrp);
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
// PAY RLUSD FOR NFT (VALIDATION + REDIRECT)
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

    // ✅ FIX #2 — validate RLUSD price before continuing
    if (!item.price_rlusd || isNaN(Number(item.price_rlusd))) {
      return res.status(400).json({ error: "Invalid RLUSD price" });
    }

    const rlusdAmount = String(Number(item.price_rlusd));

    const payload = {
      txjson: {
        TransactionType: "Payment",
        Destination: process.env.PAY_DESTINATION,
        Amount: {
          currency: "524C555344000000000000000000000000000000",
          issuer: process.env.PAY_DESTINATION,
          value: rlusdAmount
        }
      },
      options: {
        submit: true,
        return_url: {
          web: "https://centerforcreators.com/nft-marketplace",
          app: "https://centerforcreators.com/nft-marketplace"
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
// START SERVER
// ------------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log("Marketplace backend running on port", PORT);
});
