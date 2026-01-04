

import express from "express";
import cors from "cors";
import pg from "pg";
import dotenv from "dotenv";
import axios from "axios";

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
    ADD COLUMN IF NOT EXISTS is_delisted BOOLEAN DEFAULT false;
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
app.get("/", (_, res) => {
  res.send("CFC Marketplace backend running");
});
// ✅ WEBHOOK HEALTH CHECK (ADD-ONLY)
app.get("/api/xaman/webhook", (req, res) => {
  res.status(200).send("OK");
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

    // 1️⃣ Fetch submission details
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
        quantity
      FROM admin_submissions
      WHERE id = $1
      `,
      [submission_id]
    );

    if (!subRes.rows.length) {
      return res.status(404).json({ error: "Submission not found" });
    }

    const s = subRes.rows[0];

    // 2️⃣ Insert into marketplace
    await pool.query(
      `
      INSERT INTO marketplace_nfts
      (
        submission_id,
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
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,true)
      `,
      [
        s.id,
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
        s.quantity || 1
      ]
    );

    // 3️⃣ Clear cache so it appears instantly
    marketAllCache = { ts: 0, data: null };

    res.json({ ok: true });

  } catch (e) {
    console.error("add-nft error:", e);
    res.status(500).json({ error: "Failed to list NFT" });
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
        GREATEST(COALESCE(quantity,0),0) AS quantity_remaining,
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
    res.status(500).json({ error: "Failed to load market" });
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

    const payload = {
      txjson: {
        TransactionType: "NFTokenAcceptOffer",
        NFTokenSellOffer: nft.sell_offer_index_xrp
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
    const { id } = req.body;

    const r = await pool.query(
      "SELECT id, metadata_cid FROM marketplace_nfts WHERE id=$1",
      [id]
    );
    if (!r.rows.length) return res.status(404).json({ error: "Not found" });

    const xrpl = await import("xrpl");
    const client = new xrpl.Client(process.env.XRPL_NETWORK);
    await client.connect();

   const signingWallet = xrpl.Wallet.fromSeed(process.env.REGULAR_KEY_SEED);

   const nfts = await client.request({
  command: "account_nfts",
  account: "rH7tJAQ8NaZqN66pgBviQkUZy7YuioVM9k",
});
const nftToken = nfts.result.account_nfts.find(n => {
  if (n.Burned) return false;
  const uriText = xrpl.convertHexToString(n.URI || "");
  return uriText.replace("ipfs://", "").includes(
    r.rows[0].metadata_cid.replace("ipfs://", "")
  );
});
// 🔒 Fetch enforced price from database
const priceRow = await pool.query(
  "SELECT price_xrp, price_rlusd FROM marketplace_nfts WHERE id=$1",
  [id]
);

if (!priceRow.rows.length) {
  throw new Error("Price not found for NFT");
}

const nftPrice = priceRow.rows[0];

// ---- CREATE XRP SELL OFFER (if price exists) ----
if (nftPrice.price_xrp) {
  const xrpSellTx = {
    TransactionType: "NFTokenCreateOffer",
    Account: signingWallet.classicAddress,
    NFTokenID: nftToken.NFTokenID,
    Amount: String(Math.floor(parsePrice(nftPrice.price_xrp) * 1_000_000)),
    Flags: xrpl.NFTokenCreateOfferFlags.tfSellNFToken
  };

  const xrpResult = await client.submitAndWait(xrpSellTx, { wallet: signingWallet });

  const xrpNode = xrpResult.result.meta.AffectedNodes.find(
    n => n.CreatedNode?.LedgerEntryType === "NFTokenOffer"
  );

  if (!xrpNode) throw new Error("XRP sell offer failed");

  await pool.query(
    "UPDATE marketplace_nfts SET sell_offer_index=$1 WHERE id=$2",
    [xrpNode.CreatedNode.LedgerIndex, id]
  );
}

// ---- CREATE RLUSD SELL OFFER (if price exists) ----
if (nftPrice.price_rlusd) {
  const rlusdSellTx = {
    TransactionType: "NFTokenCreateOffer",
    Account: signingWallet.classicAddress,
    NFTokenID: nftToken.NFTokenID,
    Amount: {
      currency: "RLUSD",
      issuer: process.env.RLUSD_ISSUER,
      value: String(parsePrice(nftPrice.price_rlusd))
    },
    Flags: xrpl.NFTokenCreateOfferFlags.tfSellNFToken
  };

  const rlusdResult = await client.submitAndWait(rlusdSellTx, { wallet: signingWallet });

  const rlusdNode = rlusdResult.result.meta.AffectedNodes.find(
    n => n.CreatedNode?.LedgerEntryType === "NFTokenOffer"
  );

  if (!rlusdNode) throw new Error("RLUSD sell offer failed");
}

console.log("SELL OFFER RESULT:", JSON.stringify(result.result, null, 2));

    const node = result.result.meta.AffectedNodes.find(
      n => n.CreatedNode && n.CreatedNode.LedgerEntryType === "NFTokenOffer"
    );
    if (!node) throw new Error("Sell offer failed");

    const sellOfferIndex = node.CreatedNode.LedgerIndex;

    await pool.query(
      "UPDATE marketplace_nfts SET sell_offer_index=$1 WHERE id=$2",
      [sellOfferIndex, id]
    );

    await client.disconnect();
    res.json({ ok: true, sell_offer_index: sellOfferIndex });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed" });
  }
});


// ------------------------------
// XAMAN WEBHOOK (UNCHANGED)
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
    if (!nftId || !buyerWallet) return res.json({ ok: true });

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

app.listen(PORT, () => {
  console.log("Marketplace backend running on port", PORT);
});
