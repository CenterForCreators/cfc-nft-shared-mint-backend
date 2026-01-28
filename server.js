


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
  command: "nft_sell_offers",
nft_id: nftokenId 
});

if (offers.result?.offers?.length) {
  sellOfferIndex = offers.result.offers[0].nft_offer_index;
  break;
}

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
    await pool.query(`
    CREATE TABLE IF NOT EXISTS marketplace_sell_offers (
      id SERIAL PRIMARY KEY,
      marketplace_nft_id INTEGER NOT NULL,
      nftoken_id TEXT NOT NULL,
      sell_offer_index TEXT NOT NULL,
      currency TEXT NOT NULL,
      status TEXT DEFAULT 'OPEN',
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);

  // sell_offer_index must be unique (one offer index = one ledger object)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS marketplace_sell_offers_offer_uq
    ON marketplace_sell_offers (sell_offer_index);
  `);

  // prevent duplicate rows for same NFT token listing
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS marketplace_sell_offers_token_uq
    ON marketplace_sell_offers (marketplace_nft_id, nftoken_id, currency);
  `);

  // fast lookup for Pay buttons
  await pool.query(`
    CREATE INDEX IF NOT EXISTS marketplace_sell_offers_open_idx
    ON marketplace_sell_offers (marketplace_nft_id, currency, status, created_at);
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
// LIST ON MARKETPLACE (POLLING-ONLY, SAFE)
// ------------------------------
app.post("/api/list-on-marketplace", async (req, res) => {
  let xrplClient;

  try {
    const { marketplace_nft_id, currency } = req.body;
    console.log("LIST_START", { marketplace_nft_id, currency });

    if (!marketplace_nft_id || !currency) {
      return res.status(400).json({ error: "Missing params" });
    }

    const r = await pool.query(
  `
 SELECT
  m.id,
  m.submission_id,
  m.creator_wallet,
  m.metadata_cid,
  m.price_xrp,
  m.price_rlusd,
  m.nftoken_id,
  s.nftoken_ids
FROM marketplace_nfts m
JOIN submissions s
  ON s.id = m.submission_id
WHERE m.id=$1
  `,
  [marketplace_nft_id]
);
console.log("LIST_DB_OK", { rows: r.rowCount, nft: r.rows?.[0]?.id, submission_id: r.rows?.[0]?.submission_id });

    if (!r.rows.length) {
      return res.status(404).json({ error: "Marketplace NFT not found" });
    }

    const nft = r.rows[0];

    // Connect XRPL
    console.log("LIST_XRPL_CONNECTING", { XRPL_NETWORK: process.env.XRPL_NETWORK });
    xrplClient = new xrpl.Client(process.env.XRPL_NETWORK);
    await xrplClient.connect();
    console.log("LIST_XRPL_CONNECTED");

const ids = Array.isArray(nft.nftoken_ids)
  ? nft.nftoken_ids
  : JSON.parse(nft.nftoken_ids || "[]");
// ✅ Quantity=1: pick the first minted NFTokenID from submissions.nftoken_ids
// (This fixes "NFT token not set" because new rows often don't have marketplace_nfts.nftoken_id yet)
const tokenIdFromSubmission = Array.isArray(ids) && ids.length ? String(ids[0]) : null;

if (!tokenIdFromSubmission) {
  return res.status(400).json({ error: "No minted NFTokenID found for this submission" });
}

// Optional but recommended: persist it so future list/pay flows have nft.nftoken_id
if (!nft.nftoken_id) {
  await pool.query(
    `
    UPDATE marketplace_nfts
    SET nftoken_id = $1
    WHERE id = $2
      AND (nftoken_id IS NULL OR nftoken_id = '')
    `,
    [tokenIdFromSubmission, marketplace_nft_id]
  );
}

ledgerNFT = { NFTokenID: tokenIdFromSubmission };

const existing = await pool.query(
  `
  SELECT nftoken_id
  FROM marketplace_sell_offers
  WHERE marketplace_nft_id = $1
    AND currency = $2
  `,
  [marketplace_nft_id, currency]
);
const alreadyListed = new Set(
  existing.rows.map(r => String(r.nftoken_id).toUpperCase())
);

let ledgerNFT; // <-- ADD THIS ONCE, before both paths

if (false) {
  // 🔁 batch / quantity >1 logic (disabled, preserved)
  const acct = await xrplClient.request({
    command: "account_nfts",
    account: nft.creator_wallet
  });

  const expectedURI = xrpl
    .convertStringToHex(`ipfs://${nft.metadata_cid}`)
    .toUpperCase();

  const idSet = new Set(ids.map(id => String(id).toUpperCase()));

  const matching = acct.result.account_nfts.filter(n =>
    n.NFTokenID &&
    idSet.has(String(n.NFTokenID).toUpperCase()) &&
    !alreadyListed.has(String(n.NFTokenID).toUpperCase()) &&
    n.URI?.toUpperCase() === expectedURI
  );

  if (!matching.length) {
    return res.status(400).json({ error: "Correct NFT not found on XRPL" });
  }

  ledgerNFT = matching.sort((a, b) =>
    a.NFTokenID.localeCompare(b.NFTokenID)
  )[0];
}

// ✅ Quantity = 1 path (proven working — ACTIVE)

ledgerNFT = {
  NFTokenID: String(nft.nftoken_id)
};

    const Amount =
      currency === "XRP"
        ? String(Math.floor(Number(nft.price_xrp) * 1_000_000))
        : {
            currency: "524C555344000000000000000000000000000000",
            issuer: process.env.RLUSD_ISSUER,
            value: String(nft.price_rlusd)
          };

    // 🔹 CREATE SELL OFFER (NO PRE-CHECK)
    console.log("LIST_XAMAN_POSTING");
    const xumm = await axios.post(
      "https://xumm.app/api/v1/platform/payload",
      {
        txjson: {
          TransactionType: "NFTokenCreateOffer",
          Account: nft.creator_wallet,
         NFTokenID: String(ledgerNFT.NFTokenID),
          Amount,
          Flags: 1
        },
        options: {
  submit: true,
  webhook: "https://cfc-nft-shared-mint-backend.onrender.com/api/xaman/webhook",
  return_url: {
    web: "https://centerforcreators.com/nft-creator",
    app: "https://centerforcreators.com/nft-creator"
  }
        },
        custom_meta: {
  blob: {
    marketplace_nft_id: marketplace_nft_id,
    currency
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



    return res.json({ link: xumm.data.next.always });

  } catch (e) {
   console.error("LIST_ERROR_MESSAGE", e?.message);
console.error("LIST_ERROR_RESPONSE", e?.response?.status, e?.response?.data);
console.error("LIST_ERROR_STACK", e?.stack);

    return res.status(500).json({ error: "List failed" });
  } finally {
    if (xrplClient) {
      try { await xrplClient.disconnect(); } catch {}
    }
  }
});


// ------------------------------
// ADD NFT FROM CREATOR (AFTER MINT) — FIXED
// ------------------------------
app.post("/api/add-nft", async (req, res) => {
  try {
    const {
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
      quantity
    } = req.body;

    if (!submission_id || !name || !metadata_cid || !creator_wallet) {
      return res.status(400).json({ error: "Missing required fields" });
    }

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
  ON CONFLICT DO NOTHING
  `,
  [
    submission_id,
    name,
    description || "",
    category || "all",
    image_cid || null,
    metadata_cid,
    price_xrp || null,
    price_rlusd || null,
    creator_wallet,
    terms || "",
    website || "",
    Number(quantity || 1)
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
  SELECT
    n.*,
    n.quantity AS quantity_remaining,
    (GREATEST(COALESCE(n.quantity,0),0)=0) AS sold_out,
    (
      SELECT COUNT(*)
      FROM marketplace_sell_offers o
      WHERE o.marketplace_nft_id = n.id
        AND o.currency = 'XRP'
        AND COALESCE(o.status,'OPEN')='OPEN'
    )::int AS xrp_open_offers
  FROM marketplace_nfts n
  WHERE n.minted = true
    AND n.sold = false
    AND COALESCE(n.is_delisted, false) = false
  ORDER BY n.created_at DESC
`);

    marketAllCache = { ts: now, data: r.rows };
    res.json(r.rows);
 } catch (e) {
  console.error("market/all error:", e);
  return res.json([]);
}

});

// ------------------------------
// PAY XRP (FIXED)
// ------------------------------
app.post("/api/market/pay-xrp", async (req, res) => {
  try {
    const { id } = req.body;

    const nftRes = await pool.query(
      "SELECT * FROM marketplace_nfts WHERE id=$1",
      [id]
    );

    if (!nftRes.rows.length) {
      return res.status(404).json({ error: "NFT not found" });
    }

    // pull the oldest OPEN XRP sell offer for this marketplace NFT
    const offerRes = await pool.query(
      `
      SELECT sell_offer_index
      FROM marketplace_sell_offers
      WHERE marketplace_nft_id = $1
        AND currency = 'XRP'
        AND COALESCE(status,'OPEN') = 'OPEN'
      ORDER BY created_at ASC
      LIMIT 1
      `,
      [id]
    );

    if (!offerRes.rows.length) {
      return res.status(400).json({ error: "No XRP sell offer set for this NFT." });
    }

    const sellOfferIndex = String(offerRes.rows[0].sell_offer_index);

    const payload = {
      txjson: {
        TransactionType: "NFTokenAcceptOffer",
        NFTokenSellOffer: sellOfferIndex
      },
      options: {
        submit: true,
        webhook: "https://cfc-nft-shared-mint-backend.onrender.com/api/xaman/webhook",
        return_url: {
          web: "https://centerforcreators.com/nft-creator",
          app: "https://centerforcreators.com/nft-creator"
        }
      },
      custom_meta: {
        blob: {
          nft_id: id,
          sell_offer_index: sellOfferIndex,
          currency: "XRP"
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

    return res.json({ link: xumm.data.next.always });
  } catch (e) {
    console.error("pay-xrp error:", e?.response?.data || e.message);
    return res.status(500).json({ error: "Buy failed" });
  }
});

// alias for older frontend calls (keeps existing UI working)
app.post("/api/pay-xrp", (req, res) => {
  req.url = "/api/market/pay-xrp";
  return app._router.handle(req, res);
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
  webhook: "https://cfc-nft-shared-mint-backend.onrender.com/api/xaman/webhook",
  return_url: {
    web: "https://centerforcreators.com/nft-creator",
    app: "https://centerforcreators.com/nft-creator"
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
    marketplace_nft_id: marketplace_nft_id,
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
// XAMAN WEBHOOK (SELL OFFER + PURCHASE — QUANTITY SAFE)
// ------------------------------
app.post("/api/xaman/webhook", async (req, res) => {
  const client = await pool.connect();

  try {
    const p = req.body;

    console.log("WEBHOOK_RAW_BODY", JSON.stringify(p, null, 2));

    // ✅ only act on signed successful payloads
    if (
      p?.payloadResponse?.signed !== true ||
      !p?.payloadResponse?.txid
    ) {
      return res.json({ ok: true });
    }
const txid = p.payloadResponse.txid;
const metaBlob = p?.custom_meta?.blob;

if (!metaBlob) {
  return res.json({ ok: true });
}

// ------------------------------
// SAVE MINTED NFT (NFTokenMint) — REQUIRED
// ------------------------------
if (p?.txjson?.TransactionType === "NFTokenMint") {
  if (metaBlob?.submission_id && p?.meta?.AffectedNodes) {

    
    const minted = p.meta.AffectedNodes
      .filter(n => n.CreatedNode?.LedgerEntryType === "NFTokenPage")
      .flatMap(n =>
        n.CreatedNode.NewFields?.NFTokens?.map(t => t.NFToken.NFTokenID) || []
      );

    if (minted.length) {
      await pool.query(
        `
        UPDATE submissions
        SET nftoken_ids = COALESCE(nftoken_ids, '[]'::jsonb) || $1::jsonb
        WHERE id = $2
        `,
        [JSON.stringify(minted), metaBlob.submission_id]
      );
    }
  }

  return res.json({ ok: true });
}

  // ------------------------------
// SAVE SELL OFFER (NFTokenCreateOffer) — XRPL FETCH (REQUIRED)
// ------------------------------
const tx = await (async () => {
  const c = new xrpl.Client(process.env.XRPL_NETWORK);
  await c.connect();
  const r = await c.request({
    command: "tx",
    transaction: txid,
    binary: false
  });
  await c.disconnect();
  return r.result;
})();

if (tx?.TransactionType === "NFTokenCreateOffer") {
  const nodes = tx.meta?.AffectedNodes || [];

  const offerIndex =
    nodes.find(n => n.CreatedNode?.LedgerEntryType === "NFTokenOffer")
      ?.CreatedNode?.LedgerIndex ||
    nodes.find(n => n.ModifiedNode?.LedgerEntryType === "NFTokenOffer")
      ?.ModifiedNode?.LedgerIndex ||
    null;

  if (
    metaBlob?.marketplace_nft_id &&
    offerIndex &&
    tx?.NFTokenID
  ) {
    await pool.query(
      `
      INSERT INTO marketplace_sell_offers
        (marketplace_nft_id, nftoken_id, sell_offer_index, currency, status)
      VALUES ($1,$2,$3,$4,'OPEN')
      ON CONFLICT DO NOTHING
      `,
      [
        metaBlob.marketplace_nft_id,
        String(tx.NFTokenID),
        String(offerIndex),
        metaBlob.currency || "XRP"
      ]
    );
  }

  return res.json({ ok: true });
}

    // ------------------------------
    // PURCHASE (NFTokenAcceptOffer)
    // ------------------------------
    const buyer = p?.payloadResponse?.account;
    if (!metaBlob?.nft_id || !buyer) {
      return res.json({ ok: true });
    }

    await client.query("BEGIN");

    const nftRes = await client.query(
      "SELECT * FROM marketplace_nfts WHERE id=$1 FOR UPDATE",
      [metaBlob.nft_id]
    );

    if (!nftRes.rows.length || nftRes.rows[0].quantity <= 0) {
      await client.query("ROLLBACK");
      return res.json({ ok: true });
    }

    const nft = nftRes.rows[0];

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
        metaBlob.currency === "RLUSD" ? nft.price_rlusd : nft.price_xrp,
        metaBlob.currency,
        txid
      ]
    );

    if (inserted.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.json({ ok: true });
    }

    await client.query(
      `
      UPDATE marketplace_nfts
      SET quantity = quantity - 1,
          sold_count = sold_count + 1
      WHERE id = $1
      `,
      [nft.id]
    );

    if (metaBlob?.sell_offer_index) {
      await client.query(
        `
        UPDATE marketplace_sell_offers
        SET status='USED'
        WHERE sell_offer_index=$1
        `,
        [String(metaBlob.sell_offer_index)]
      );
    }

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
