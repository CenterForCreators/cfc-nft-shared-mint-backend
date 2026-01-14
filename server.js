


import express from "express";
import cors from "cors";
import pg from "pg";
import dotenv from "dotenv";
import axios from "axios";
import xrpl from "xrpl";
async function pollForSellOffer({
  client,
  account,
  nftokenId,
  timeoutMs = 15000
}) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const offers = await client.request({
      command: "account_objects",
      account,
      type: "nft_offer"
    });

    const found = offers.result.account_objects.find(
      o => o.NFTokenID === nftokenId && o.Flags === 1
    );

    if (found?.index) return found.index;

    await new Promise(r => setTimeout(r, 1500));
  }

  return null;
}

dotenv.config();
const PLATFORM_FEE_PERCENT = 0.05;
const CREATOR_PERCENT = 0.95;

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
      category TEXT,
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
   await pool.query(`
    ALTER TABLE marketplace_nfts
    ADD COLUMN IF NOT EXISTS nftoken_id TEXT;
  `);
  await pool.query(`
    ALTER TABLE marketplace_nfts
    ADD COLUMN IF NOT EXISTS is_delisted BOOLEAN DEFAULT false;
  `);
    await pool.query(`
    ALTER TABLE marketplace_nfts
    ADD COLUMN IF NOT EXISTS sell_offer_index_xrp TEXT;
  `);

  await pool.query(`
    ALTER TABLE marketplace_nfts
    ADD COLUMN IF NOT EXISTS sell_offer_index_rlusd TEXT;
  `);

  await pool.query(`
    ALTER TABLE marketplace_nfts
    ADD COLUMN IF NOT EXISTS sell_offer_index TEXT;
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
// SIMPLE IN-MEMORY CACHE (STEP 8A)
// ------------------------------
let marketAllCache = {
  ts: 0,
  data: null
};
const MARKET_ALL_TTL_MS = 10_000; // 10 seconds

// ------------------------------
// HELPERS
// ------------------------------
function parsePrice(raw) {
  if (!raw) return NaN;
  if (typeof raw === "number") return raw;
  const cleaned = raw.replace(/[^0-9.]/g, "");
  return Number(cleaned);
}

// ------------------------------
// APP
// ------------------------------
const app = express();
app.use(express.json());
app.use(cors());

// ------------------------------
// ------------------------------
// LIST ON MARKETPLACE (FINAL — POLLING ONLY)
// ------------------------------
app.post("/api/list-on-marketplace", async (req, res) => {
  let client;

  try {
    const { marketplace_nft_id, currency } = req.body;
    if (!marketplace_nft_id || !currency) {
      return res.status(400).json({ error: "Missing params" });
    }

    const r = await pool.query(
      `SELECT id, creator_wallet, metadata_cid, price_xrp, price_rlusd
       FROM marketplace_nfts
       WHERE id = $1`,
      [marketplace_nft_id]
    );
    if (!r.rows.length) {
      return res.status(404).json({ error: "Marketplace NFT not found" });
    }

    const nft = r.rows[0];

    client = new xrpl.Client(process.env.XRPL_NETWORK);
    await client.connect();

    const acct = await client.request({
      command: "account_nfts",
      account: nft.creator_wallet
    });

    const expectedURI = xrpl
      .convertStringToHex(`ipfs://${nft.metadata_cid}`)
      .toUpperCase();

    const ledgerNFT = acct.result.account_nfts.find(
      n => n.URI?.toUpperCase() === expectedURI
    );

    if (!ledgerNFT?.NFTokenID) {
      return res.status(400).json({ error: "NFToken not found on XRPL" });
    }

    const Amount =
      currency === "XRP"
        ? String(Math.floor(Number(nft.price_xrp) * 1_000_000))
        : {
            currency: "524C555344000000000000000000000000000000",
            issuer: process.env.RLUSD_ISSUER,
            value: String(nft.price_rlusd)
          };

    // 1️⃣ Create sell offer via Xaman
    const xumm = await axios.post(
      "https://xumm.app/api/v1/platform/payload",
      {
        txjson: {
          TransactionType: "NFTokenCreateOffer",
          Account: nft.creator_wallet,
          NFTokenID: ledgerNFT.NFTokenID,
          Amount,
          Flags: 1
        },
        options: {
          submit: true,
          return_url: {
            web: "https://centerforcreators.com/nft-creator",
            app: "https://centerforcreators.com/nft-creator"
          }
        }
      },
      {
        headers: {
          "X-API-Key": process.env.XUMM_API_KEY,
          "X-API-Secret": process.env.XUMM_API_SECRET
        }
      }
    );

    // 2️⃣ Poll XRPL for created sell offer
    let sellOfferIndex = null;

    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 2000));

      const offers = await client.request({
        command: "account_objects",
        account: nft.creator_wallet,
        type: "nft_offer"
      });

      const offer = offers.result.account_objects.find(
        o =>
          o.NFTokenID === ledgerNFT.NFTokenID &&
          o.Flags === 1
      );

      if (offer) {
        sellOfferIndex = offer.index;
        break;
      }
    }

    if (!sellOfferIndex) {
      return res.status(500).json({ error: "Sell offer not found on XRPL" });
    }

    // 3️⃣ Save sell offer index (THIS IS WHAT MAKES PAY BUTTONS WORK)
    if (currency === "XRP") {
      await pool.query(
        "UPDATE marketplace_nfts SET sell_offer_index_xrp=$1 WHERE id=$2",
        [sellOfferIndex, marketplace_nft_id]
      );
    } else {
      await pool.query(
        "UPDATE marketplace_nfts SET sell_offer_index_rlusd=$1 WHERE id=$2",
        [sellOfferIndex, marketplace_nft_id]
      );
    }

    return res.json({ link: xumm.data.next.always });

  } catch (e) {
    console.error("list-on-marketplace error:", e);
    return res.status(500).json({ error: "List failed" });
  } finally {
    if (client) {
      try { await client.disconnect(); } catch {}
    }
  }
});


// ------------------------------
// ADD NFT FROM CREATOR (AFTER MINT)
// ------------------------------

app.post("/api/add-nft", async (req, res) => {
  try {
    const { submission_id } = req.body;

    if (!submission_id) {
      return res.status(400).json({ error: "submission_id required" });
    }

const subRes = await pool.query(
  `
  SELECT
    id,
    name,
    description,
    category,
    image_cid,
    metadata_cid,
    price_xrp,
    price_rlusd,
    creator_wallet,
    terms,
    website,
    batch_qty AS quantity
  FROM submissions
  WHERE id = $1
  `,
  [submission_id]
);

if (!subRes.rows.length) {
  return res.status(404).json({ error: "Submission not found" });
}

const s = subRes.rows[0];

// 2️⃣ Insert ONE marketplace row with batch quantity
await pool.query(
  `
INSERT INTO marketplace_nfts
(
  submission_id,
  nftoken_id,
  name,
  description,
  category,
  image_cid,
  metadata_cid,
  price_xrp,
  price_rlusd,
  creator_wallet,
  terms,
  website,
  quantity,
  minted
)

 VALUES
($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,true)
  `,
  [
  s.id,
  s.nftoken_id,
  s.name,
  s.description || "",
  s.category || "all",
  s.image_cid,
  s.metadata_cid,
  s.price_xrp || null,
  s.price_rlusd || null,
  s.creator_wallet,
  s.terms || "",
  s.website || "",
  Number(s.quantity || 1)
]

);
      res.json({ ok: true });

  } catch (e) {
    console.error("add-nft error:", e);
    res.status(500).json({ error: "Failed to add NFT" });
  }
});
 
// ------------------------------
// GET ALL NFTs (CACHED — STEP 8A)
// ------------------------------
app.get("/api/market/all", async (_, res) => {
  try {
    const now = Date.now();

    if (marketAllCache.data && (now - marketAllCache.ts) < MARKET_ALL_TTL_MS) {
      return res.json(marketAllCache.data);
    }

    const r = await pool.query(`
      SELECT *,
        (
  SELECT COUNT(*)
  FROM marketplace_nfts m2
  WHERE m2.submission_id = marketplace_nfts.submission_id
    AND m2.sold = false
    AND COALESCE(m2.is_delisted, false) = false
) AS quantity_remaining,

        (GREATEST(COALESCE(quantity,0),0)=0) AS sold_out
      FROM marketplace_nfts
      WHERE minted = true
        AND sold = false
        AND COALESCE(is_delisted, false) = false
      ORDER BY created_at DESC
    `);

    marketAllCache = { ts: now, data: r.rows };
    res.json(r.rows);
 } catch (e) {
  console.error("market/all error:", e);
  return res.json([]);
}

});

// ------------------------------
// PAY XRP (WORKING)
// ------------------------------
app.post("/api/market/pay-xrp", async (req, res) => {
  try {
    const { id } = req.body;

    const r = await pool.query(
      "SELECT * FROM marketplace_nfts WHERE id=$1",
      [id]
    );

    if (!r.rows.length) {
      return res.status(404).json({ error: "NFT not found" });
    }

   const nft = r.rows[0];
if (!nft.sell_offer_index_xrp && !nft.sell_offer_index) {
  return res.status(400).json({ error: "No XRP sell offer set for this NFT. Run create-sell-offer first." });
}

    const payload = {
      txjson: {
        TransactionType: "NFTokenAcceptOffer",
       NFTokenSellOffer: nft.sell_offer_index_xrp || nft.sell_offer_index
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

    const xumm = await axios.post(
      "https://xumm.app/api/v1/platform/payload",
      payload,
      {
        headers: {
          "X-API-Key": process.env.XUMM_API_KEY,
          "X-API-Secret": process.env.XUMM_API_SECRET
        }
      }
    );

    res.json({ link: xumm.data.next.always });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Buy failed" });
  }
});


// ------------------------------
// PAY RLUSD (WORKING)
// ------------------------------
app.post("/api/market/pay-rlusd", async (req, res) => {
  try {
    const { id } = req.body;

    const r = await pool.query(
      "SELECT * FROM marketplace_nfts WHERE id=$1",
      [id]
    );

    if (!r.rows.length) {
      return res.status(404).json({ error: "NFT not found" });
    }

    const nft = r.rows[0];
    if (!nft.sell_offer_index_rlusd) {
  return res.status(400).json({ error: "No RLUSD sell offer set for this NFT. Run create-sell-offer first." });
}


    const payload = {
      txjson: {
        TransactionType: "NFTokenAcceptOffer",
        NFTokenSellOffer: nft.sell_offer_index_rlusd
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

    const xumm = await axios.post(
      "https://xumm.app/api/v1/platform/payload",
      payload,
      {
        headers: {
          "X-API-Key": process.env.XUMM_API_KEY,
          "X-API-Secret": process.env.XUMM_API_SECRET
        }
      }
    );

    res.json({ link: xumm.data.next.always });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Buy failed" });
  }
});
app.post("/api/admin/create-sell-offer", async (req, res) => {
  try {
    const { id, currency } = req.body;

    const r = await pool.query(
      "SELECT id, nftoken_id, creator_wallet, price_xrp, price_rlusd FROM marketplace_nfts WHERE id=$1",
      [id]
    );

    if (!r.rows.length) {
      return res.status(404).json({ error: "NFT not found" });
    }

    const nft = r.rows[0];


    let amount;
    if (currency === "XRP") {
      amount = String(Math.floor(Number(nft.price_xrp) * 1_000_000));
    } else {
      amount = {
        currency: "524C555344000000000000000000000000000000",
        issuer: process.env.RLUSD_ISSUER,
        value: String(nft.price_rlusd)
      };
    }

    const payload = {
      txjson: {
        TransactionType: "NFTokenCreateOffer",
        Account: nft.creator_wallet,
        NFTokenID: nft.nftoken_id,
        Amount: amount,
        Flags: 1
      },
      options: {
        submit: true
      },
      custom_meta: {
        blob: {
          marketplace_id: nft.id,
          currency
        }
      }
    };

    const xumm = await axios.post(
      "https://xumm.app/api/v1/platform/payload",
      payload,
      {
        headers: {
          "X-API-Key": process.env.XUMM_API_KEY,
          "X-API-Secret": process.env.XUMM_API_SECRET
        }
      }
    );

    res.json({ link: xumm.data.next.always });

  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to create sell offer" });
  }
});


// ------------------------------
// GET ORDERS BY WALLET
// ------------------------------
app.get("/api/orders/by-wallet/:wallet", async (req, res) => {
const r = await pool.query(
  `
  SELECT o.*, n.name, n.image_cid, n.metadata_cid, n.submission_id
  FROM orders o
  JOIN marketplace_nfts n ON n.id = o.marketplace_nft_id
  WHERE o.buyer_wallet = $1
  ORDER BY o.created_at DESC
  `,
  [wallet]
);

res.json(r.rows);

});
app.post("/api/market/toggle-delist", async (req, res) => {
  try {
    const { submission_id, delist } = req.body;

    if (!Number.isFinite(Number(submission_id))) {
      return res.status(400).json({ error: "Invalid submission_id" });
    }

    await pool.query(
      "UPDATE marketplace_nfts SET is_delisted=$1 WHERE submission_id=$2",
      [!!delist, Number(submission_id)]
    );

    // clear cache so it reflects instantly
    marketAllCache = { ts: 0, data: null };

    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Toggle delist failed" });
  }
});

// ------------------------------
// STEP 5 — REDEEM REQUEST
// ------------------------------
app.post("/api/orders/redeem", async (req, res) => {
  const { order_id, wallet, email } = req.body;

  if (!order_id || !wallet || !email) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const r = await pool.query(
    `
    UPDATE orders
    SET status='REDEEM_REQUESTED',
        buyer_email=$1
    WHERE id=$2 AND buyer_wallet=$3 AND status='PAID'
    RETURNING id
    `,
    [email, order_id, wallet]
  );

  if (!r.rows.length) {
    return res.status(400).json({ error: "Invalid order or already redeemed" });
  }

  res.json({ ok: true });

});

// ------------------------------
const PORT = process.env.PORT || 5000;


// ------------------------------
// XAMAN WEBHOOK (PURCHASE ONLY — QUANTITY SAFE)
// ------------------------------
app.post("/api/xaman/webhook", async (req, res) => {
  const client = await pool.connect();

  try {
    const p = req.body?.payload;

    if (
      p?.response?.dispatched_result !== "tesSUCCESS" ||
      p?.meta?.signed !== true
    ) {
      return res.json({ ok: true });
    }

    const blob = p?.custom_meta?.blob;
    const txid = p?.response?.txid;
    const buyer = p?.response?.account;

    if (!txid || !blob?.nft_id || !buyer) {
      return res.json({ ok: true });
    }

    await client.query("BEGIN");

    // 🔹 LOCK NFT ROW
    const nftRes = await client.query(
      "SELECT * FROM marketplace_nfts WHERE id=$1 FOR UPDATE",
      [blob.nft_id]
    );

    if (!nftRes.rows.length || nftRes.rows[0].quantity <= 0) {
      await client.query("ROLLBACK");
      return res.json({ ok: true });
    }

    const nft = nftRes.rows[0];

    // 🔹 RECORD ORDER (idempotent)
    const inserted = await client.query(
      `
      INSERT INTO orders
        (marketplace_nft_id, buyer_wallet, price, currency, tx_hash)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT DO NOTHING
      RETURNING id
      `,
      [
        nft.id,
        buyer,
        blob.currency === "RLUSD" ? nft.price_rlusd : nft.price_xrp,
        blob.currency,
        txid
      ]
    );

    if (inserted.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.json({ ok: true });
    }

    // ✅ DECREMENT QUANTITY **ONLY ON PURCHASE**
    await client.query(
      `
      UPDATE marketplace_nfts
      SET quantity = quantity - 1,
          sold_count = sold_count + 1
      WHERE id = $1
      `,
      [nft.id]
    );

    await client.query("COMMIT");
    res.json({ ok: true });

  } catch (e) {
    await client.query("ROLLBACK");
    console.error("❌ webhook error:", e);
    res.status(500).json({ error: "webhook failed" });
  } finally {
    client.release();
  }
});

app.listen(PORT, () => {
  console.log("Marketplace backend running on port", PORT);
});
