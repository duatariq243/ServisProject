import express from "express";
import bodyParser from "body-parser";
import bcrypt from "bcrypt";
import dotenv from "dotenv";
import session from "express-session";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import pkg from "pg";
import multer from "multer";
import AWS from "aws-sdk";
import Stripe from "stripe";

dotenv.config();
const { Client } = pkg;
const stripe = new Stripe(process.env.STRIPE_SECRET, { apiVersion: "2022-11-15" });
const app = express();
const port = process.env.PORT || 3000;

/*---------------------- MIDDLEWARE (must be before webhook) ---------------------*/
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json()); // REQUIRED for create-checkout-session
app.use(express.static("public"));
app.set("view engine", "ejs");

app.use(
  session({
    secret: process.env.MY_SECRET_KEY,
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 1000 * 60 * 60 * 24 }
  })
);

// make session user available to EJS
app.use((req, res, next) => {
  res.locals.user = req.session.user;
  next();
});

/*---------------------------------- Database ----------------------------------*/
const db = new Client({
  host: process.env.PG_HOST,
  port: process.env.PG_PORT,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE
});
await db.connect();

/*------------------------------ AWS File Upload ------------------------------*/
const upload = multer({ storage: multer.memoryStorage() });

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_KEY,
  secretAccessKey: process.env.AWS_SECRET,
  region: process.env.AWS_REGION
});

/*--------------------------- Authentication Middleware ------------------------*/
const requireLogin = (req, res, next) => !req.session.user ? res.redirect("/login") : next();
const requireAdmin = (req, res, next) =>
  (!req.session.user || !req.session.user.isAdmin) ? res.send("Admins only") : next();

/*-------------------------------- Google Login -------------------------------*/
app.use(passport.initialize());
app.use(passport.session());

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: `${process.env.DOMAIN_URL}/auth/google/callback`
    },
    (accessToken, refreshToken, profile, done) => {
      return done(null, {
        name: profile.displayName,
        email: profile.emails[0].value
      });
    }
  )
);

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

/*---------------------------------- Routes ----------------------------------*/
app.get("/", async (req, res) => {
  const result = await db.query("SELECT * FROM products ORDER BY id DESC");
  res.render("index.ejs", { products: result.rows });
});

app.get("/products", async (req, res) => {
  const result = await db.query("SELECT * FROM products ORDER BY id DESC");
  res.render("products.ejs", { products: result.rows });
});

/*---------------------------------- Cart ----------------------------------*/
app.get("/cart", requireLogin, async (req, res) => {
  const uid = req.session.user.id;
  const result = await db.query(
    `SELECT cart.id AS cart_id,products.id AS product_id,products.name,products.price,cart.quantity
     FROM cart JOIN products ON cart.product_id=products.id WHERE cart.user_id=$1`, [uid]
  );

  const total = result.rows.reduce((sum, x) => sum + x.price * x.quantity, 0);
  res.render("cart.ejs", { cart: result.rows, total });
});

app.post("/add-to-cart", requireLogin, async (req, res) => {
  const uid = req.session.user.id;
  const { productId } = req.body;

  const exist = await db.query("SELECT * FROM cart WHERE user_id=$1 AND product_id=$2", [uid, productId]);
  exist.rows.length ?
    await db.query("UPDATE cart SET quantity=quantity+1 WHERE user_id=$1 AND product_id=$2",[uid,productId]) :
    await db.query("INSERT INTO cart(user_id,product_id,quantity) VALUES($1,$2,1)",[uid,productId]);

  res.redirect("/cart");
});

/*----------------------------- STRIPE CHECKOUT ------------------------------*/
app.post("/create-checkout-session", requireLogin, async (req, res) => {
  const uid = req.session.user.id;
  const cart = await db.query(
    `SELECT products.name,products.price,cart.quantity
     FROM cart JOIN products ON cart.product_id=products.id WHERE user_id=$1`, [uid]
  );

  if (!cart.rows.length) return res.send("Cart empty");

  const session = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    line_items: cart.rows.map(x => ({
      price_data: {
        currency: "usd",
        product_data: { name: x.name },
        unit_amount: x.price * 100
      },
      quantity: x.quantity
    })),
    success_url: `${process.env.DOMAIN_URL}/success`,
    cancel_url: `${process.env.DOMAIN_URL}/cart`
  });

  res.redirect(session.url);
});

app.get("/success", (req, res) =>
  res.send("✔️ Payment Successful<br><a href='/products'>Shop Again</a>")
);

/*-------------------------------- WEBHOOK (must stay LAST!) --------------------------------*/
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  try {
    const sig = req.headers["stripe-signature"];
    const event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);

    if (event.type === "checkout.session.completed") {
      console.log("✔ PAYMENT RECEIVED");
      // TODO: clear cart / mark order paid
    }

    res.json({ received: true });
  } catch (err) {
    console.error(err.message);
    res.status(400).send(`Webhook Error: ${err.message}`);
  }
});

app.listen(port, () => console.log(`🚀 Live On → ${process.env.DOMAIN_URL}`));
