import express from "express";
import cors from "cors";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;

// ------------------------------
// DATABASE
// ------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Create table if not exists
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS marketplace_nfts (
      id SERIAL PRIMARY KEY,
      submission_id INTEGER,
      name TEXT,
      image_cid TEXT,
      metadata_cid TEXT,
      price_xrp TEXT,
      price_rlusd TEXT,
      creator_wallet TEXT,
      minted BOOLEAN DEFAULT false,
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
// GET ALL MARKETPLACE NFTs
// ------------------------------
app.get("/api/nfts", async (req, res) => {
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
// START SERVER
// ------------------------------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log("Marketplace backend running on port", PORT);
});
