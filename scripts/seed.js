import dotenv from 'dotenv';
import pkg from 'pg';
const { Client } = pkg;
import express from "express";

dotenv.config();
const isLocal = process.env.NODE_ENV !== 'production';
app.use(express.static("public"));


// Use the same DB config as your main app
const db = new Client({
  host: process.env.PG_HOST,
  port: process.env.PG_PORT,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE,
  ssl: { rejectUnauthorized: false } // required for Render hosted DB
});

async function runSeed() {
  try {
    await db.connect();

    // Example: create tables if they don't exist
    await db.query(`
      CREATE TABLE IF NOT EXISTS products (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        price NUMERIC(10,2) NOT NULL,
        description TEXT,
        image TEXT
      );
      
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password TEXT,
        google_id TEXT,
        is_admin BOOLEAN DEFAULT false
      );
      
      CREATE TABLE IF NOT EXISTS cart (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
        quantity INTEGER DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS orders (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        total NUMERIC(10,2),
        created_at TIMESTAMP DEFAULT now()
      );
    `);

    // Example: insert initial product
    await db.query(`
      INSERT INTO products (name, price, description, image)
      VALUES 
      ('Sample Product 1', 19.99, 'First test item', 'https://placehold.co/300'),
      ('Sample Product 2', 24.50, 'Second test item', 'https://placehold.co/300')
      ON CONFLICT DO NOTHING;
    `);

    console.log("🌱 Database schema created & initial data seeded!");
    await db.end();
  } catch (err) {
    console.error("❌ Seed error:", err);
    await db.end();
  }
}

runSeed();
