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

const { Client } = pkg;
dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// ------------------- Middleware -------------------
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));
app.set("view engine", "ejs");

// Session store
app.use(
  session({
    secret: process.env.MY_SECRET_KEY,
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 1000 * 60 * 60 * 24 } // 1 day
  })
);

// Make session user available in all templates
app.use((req, res, next) => {
  res.locals.user = req.session.user;
  res.locals.cartCount = req.session.cart ? req.session.cart.length : 0;
  next();
});

// ------------------- Database -------------------
const db = new Client({
  host: process.env.PG_HOST,
  port: process.env.PG_PORT,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  database: process.env.PG_DATABASE,
  ssl: false
});
db.connect();

// ------------------- Stripe -------------------
const stripe = new Stripe(process.env.STRIPE_SECRET, { apiVersion: "2022-11-15" });

// ------------------- Multer -------------------
// We will upload to S3
const storage = multer.memoryStorage(); // store file in memory
const upload = multer({ storage });

// ------------------- AWS S3 -------------------
const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_KEY,
  secretAccessKey: process.env.AWS_SECRET,
  region: process.env.AWS_REGION
});

// ------------------- Auth Middleware -------------------
function requireLogin(req, res, next) {
  if (!req.session.user) return res.redirect("/login");
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.user || !req.session.user.isAdmin) {
    return res.send("Access denied. Admins only.");
  }
  next();
}

// ------------------- Passport -------------------
app.use(passport.initialize());
app.use(passport.session());

passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: "http://localhost:3000/auth/google/callback"
    },
    (accessToken, refreshToken, profile, done) => {
      const user = { email: profile.emails[0].value, name: profile.displayName };
      return done(null, user);
    }
  )
);

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// ------------------- Routes -------------------

// Home
app.get("/", async (req, res) => {
  const result = await db.query("SELECT * FROM products ORDER BY id DESC");
  res.render("index.ejs", { products: result.rows });
});

// Products
app.get("/products", async (req, res) => {
  const result = await db.query("SELECT * FROM products ORDER BY id DESC");
  res.render("products.ejs", { products: result.rows });
});

// ------------------- Admin Routes -------------------
app.get("/admin", requireAdmin, async (req, res) => {
  const result = await db.query("SELECT * FROM products ORDER BY id DESC");
  res.render("admin.ejs", { products: result.rows });
});

app.get("/admin/add-product", requireAdmin, (req, res) => {
  res.render("add-product.ejs");
});

// Upload product with S3
app.post("/admin/add-product", requireAdmin, upload.single("image"), async (req, res) => {
  try {
    const { name, price, description } = req.body;
    const file = req.file;
    if (!file) return res.send("Please upload an image.");

    // Upload to S3
    const params = {
      Bucket: process.env.AWS_BUCKET,  // servis-project-images
      Key: `${Date.now()}-${file.originalname}`,
      Body: file.buffer,
      ContentType: file.mimetype, // e.g., image/webp
      ACL: "public-read"
    };

    const uploadResult = await s3.upload(params).promise();
    const imageUrl = uploadResult.Location; // public URL of S3 image

    // Insert into DB
    await db.query(
      "INSERT INTO products(name, price, description, image) VALUES($1,$2,$3,$4)",
      [name, price, description, imageUrl]
    );

    res.redirect("/admin");
  } catch (err) {
    console.error("Add product error:", err);
    res.send("Error adding product");
  }
});


app.get("/admin/edit-product/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  const result = await db.query("SELECT * FROM products WHERE id=$1", [id]);
  res.render("edit-product.ejs", { product: result.rows[0] });
});

app.post("/admin/edit-product/:id", requireAdmin, upload.single("image"), async (req, res) => {
  const { id } = req.params;
  const { name, price, description, old_image } = req.body;

  let imageUrl = old_image;

  if (req.file) {
    const params = {
      Bucket: process.env.AWS_BUCKET,
      Key: `${Date.now()}-${req.file.originalname}`,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
      ACL: "public-read"
    };
    const uploadResult = await s3.upload(params).promise();
    imageUrl = uploadResult.Location;
  }

  await db.query(
    "UPDATE products SET name=$1, price=$2, description=$3, image=$4 WHERE id=$5",
    [name, price, description, imageUrl, id]
  );

  res.redirect("/admin");
});


app.post("/admin/delete-product/:id", requireAdmin, async (req, res) => {
  const { id } = req.params;
  await db.query("DELETE FROM products WHERE id=$1", [id]);
  res.redirect("/admin");
});

// ------------------- Auth Routes -------------------
app.get("/signup", (req, res) => res.render("signup.ejs"));
app.post("/signup", async (req, res) => {
  const { email, password } = req.body;
  const hashed = await bcrypt.hash(password, 10);
  await db.query("INSERT INTO users(email, password) VALUES($1,$2)", [email, hashed]);
  res.redirect("/login");
});

app.get("/login", (req, res) => res.render("login.ejs"));
app.post("/login", async (req, res) => {
  const { email, password } = req.body;
  const result = await db.query("SELECT * FROM users WHERE email=$1", [email]);
  if (result.rows.length === 0) return res.send("User not found");
  const user = result.rows[0];
  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.send("Wrong password");

  req.session.user = {
    id: user.id,
    email: user.email,
    isAdmin: user.is_admin === true || user.is_admin === "t"
  };
  res.redirect("/products");
});

app.get("/logout", (req, res) => {
  req.session.destroy();
  res.redirect("/login");
});

// ------------------- Cart Routes -------------------
app.post("/add-to-cart", requireLogin, async (req, res) => {
  const { productId } = req.body;
  const userId = req.session.user.id;

  const existing = await db.query(
    "SELECT * FROM cart WHERE user_id=$1 AND product_id=$2",
    [userId, productId]
  );

  if (existing.rows.length > 0) {
    await db.query(
      "UPDATE cart SET quantity = quantity + 1 WHERE user_id=$1 AND product_id=$2",
      [userId, productId]
    );
  } else {
    await db.query(
      "INSERT INTO cart(user_id, product_id, quantity) VALUES($1,$2,1)",
      [userId, productId]
    );
  }
  res.redirect("/cart");
});

app.get("/cart", requireLogin, async (req, res) => {
  const userId = req.session.user.id;
  const result = await db.query(
    `SELECT cart.id AS cart_id, products.id AS product_id, products.name, products.price, cart.quantity
     FROM cart JOIN products ON cart.product_id = products.id
     WHERE cart.user_id=$1`,
    [userId]
  );
  const cartItems = result.rows;
  const total = cartItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
  res.render("cart.ejs", { cart: cartItems, total });
});

app.post("/cart/update", requireLogin, async (req, res) => {
  const { cart_id, action } = req.body;
  if (action === "increment") {
    await db.query("UPDATE cart SET quantity = quantity + 1 WHERE id=$1", [cart_id]);
  } else if (action === "decrement") {
    const result = await db.query("SELECT quantity FROM cart WHERE id=$1", [cart_id]);
    if (result.rows[0].quantity > 1) {
      await db.query("UPDATE cart SET quantity = quantity - 1 WHERE id=$1", [cart_id]);
    } else {
      await db.query("DELETE FROM cart WHERE id=$1", [cart_id]);
    }
  }
  res.redirect("/cart");
});

// ------------------- Checkout -------------------
app.get("/checkout", requireLogin, async (req, res) => {
  const userId = req.session.user.id;
  const result = await db.query(
    `SELECT cart.id AS cart_id, products.id AS product_id, products.name, products.price, cart.quantity
     FROM cart JOIN products ON cart.product_id = products.id
     WHERE cart.user_id=$1`,
    [userId]
  );
  const cartItems = result.rows;
  if (cartItems.length === 0) return res.send("Cart is empty");
  const total = cartItems.reduce((sum, item) => sum + item.price * item.quantity, 0);
  res.render("checkout.ejs", { cartItems, total, totalCents: total * 100 });
});

app.post("/create-checkout-session", requireLogin, async (req, res) => {
  const userId = req.session.user.id;

  // Get cart items
  const cartResult = await db.query(
    `SELECT products.name, products.price, cart.quantity
     FROM cart
     JOIN products ON cart.product_id = products.id
     WHERE cart.user_id = $1`,
    [userId]
  );

  const cartItems = cartResult.rows;
  if (!cartItems.length) return res.send("Cart is empty");

  try {
    // Create Stripe checkout session
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ["card"],
      mode: "payment",
      line_items: cartItems.map(item => ({
        price_data: {
          currency: "usd",
          product_data: { name: item.name },
          unit_amount: Math.round(item.price * 100) // in cents
        },
        quantity: item.quantity
      })),
      success_url: `${process.env.DOMAIN_URL}/success`,
      cancel_url: `${process.env.DOMAIN_URL}/cart`
    });

    res.redirect(session.url); // redirect to Stripe checkout
  } catch (err) {
    console.error("Stripe checkout error:", err);
    res.status(500).send("Stripe checkout failed");
  }
});

app.post("/webhook", bodyParser.raw({ type: "application/json" }), (req, res) => {
  const sig = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature verification failed:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle the event
  switch (event.type) {
    case "checkout.session.completed":
      const session = event.data.object;
      console.log("Payment succeeded for session:", session.id);
      // TODO: mark order as paid in your DB
      break;
    case "payment_intent.succeeded":
      console.log("PaymentIntent succeeded:", event.data.object.id);
      break;
    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  res.json({ received: true });
});
// ------------------- Start Server -------------------
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
