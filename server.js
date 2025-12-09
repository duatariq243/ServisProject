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



/*---------------------------------- Middleware ----------------------------------*/
app.use(bodyParser.urlencoded({ extended: true }));
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

// share session user globally in ejs
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
  database: process.env.PG_DATABASE,
  ssl: { rejectUnauthorized: false }   // required for RENDER
});
await db.connect();

/*---------------------------------- AWS S3 Upload ----------------------------------*/
const upload = multer({ storage: multer.memoryStorage() });

const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_KEY,
  secretAccessKey: process.env.AWS_SECRET,
  region: process.env.AWS_REGION
});

/*---------------------------------- Auth Middleware ----------------------------------*/
const requireLogin = (req, res, next) => {
  if (!req.session.user) return res.redirect("/login");
  next();
};

const requireAdmin = (req, res, next) => {
  if (!req.session.user || !req.session.user.isAdmin)
    return res.send("Access denied (Admins only)");
  next();
};

/*---------------------------------- Google Login ----------------------------------*/
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

// HOME
app.get("/", async (req, res) => {
  const result = await db.query("SELECT * FROM products ORDER BY id DESC");
  res.render("index.ejs", { products: result.rows });
});

app.get("/products", async (req, res) => {
  const result = await db.query("SELECT * FROM products ORDER BY id DESC");
  res.render("products.ejs", { products: result.rows });
});

/*---------------------------------- Admin ----------------------------------*/
app.get("/admin", requireAdmin, async (req, res) => {
  const result = await db.query("SELECT * FROM products ORDER BY id DESC");
  res.render("admin.ejs", { products: result.rows });
});

app.get("/admin/add-product", requireAdmin, (req, res) => {
  res.render("add-product.ejs");
});

app.post("/admin/add-product", requireAdmin, upload.single("image"), async (req, res) => {
  try {
    const { name, price, description } = req.body;
    const file = req.file;
    if (!file) return res.send("Upload image required");

    const uploadRes = await s3.upload({
      Bucket: process.env.AWS_BUCKET,
      Key: Date.now() + "-" + file.originalname,
      Body: file.buffer,
      ContentType: file.mimetype,
      ACL: "public-read"
    }).promise();

    await db.query(
      "INSERT INTO products(name, price, description, image) VALUES($1,$2,$3,$4)",
      [name, price, description, uploadRes.Location]
    );

    res.redirect("/admin");
  } catch (err) {
    console.error(err);
    res.send("Error adding");
  }
});

/*---------------------------------- Edit Product ----------------------------------*/
app.get("/admin/edit-product/:id", requireAdmin, async (req, res) => {
  const result = await db.query("SELECT * FROM products WHERE id=$1", [req.params.id]);
  res.render("edit-product.ejs", { product: result.rows[0] });
});

app.post("/admin/edit-product/:id", requireAdmin, upload.single("image"), async (req, res) => {
  const { name, price, description, old_image } = req.body;
  let image = old_image;

  if (req.file) {
    const uploadRes = await s3.upload({
      Bucket: process.env.AWS_BUCKET,
      Key: Date.now() + "-" + req.file.originalname,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
      ACL: "public-read"
    }).promise();
    image = uploadRes.Location;
  }

  await db.query("UPDATE products SET name=$1, price=$2, description=$3, image=$4 WHERE id=$5",
    [name, price, description, image, req.params.id]
  );
  res.redirect("/admin");
});

app.post("/admin/delete-product/:id", requireAdmin, async (req, res) => {
  await db.query("DELETE FROM products WHERE id=$1", [req.params.id]);
  res.redirect("/admin");
});

/*---------------------------------- Auth ----------------------------------*/
app.get("/signup", (req, res) => res.render("signup.ejs"));
app.post("/signup", async (req, res) => {
  const hashed = await bcrypt.hash(req.body.password, 10);
  await db.query("INSERT INTO users(email,password) VALUES($1,$2)", [req.body.email, hashed]);
  res.redirect("/login");
});

app.get("/login", (req, res) => res.render("login.ejs"));
app.post("/login", async (req, res) => {
  const result = await db.query("SELECT * FROM users WHERE email=$1", [req.body.email]);
  if (!result.rows.length) return res.send("User not found");

  const user = result.rows[0];
  const match = await bcrypt.compare(req.body.password, user.password);
  if (!match) return res.send("Wrong password");

  req.session.user = { id: user.id, email: user.email, isAdmin: user.is_admin };
  res.redirect("/products");
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

/*---------------------------------- Cart ----------------------------------*/
app.get("/cart", requireLogin, async (req, res) => {
  const userId = req.session.user.id;
  const result = await db.query(
    `SELECT cart.id AS cart_id,products.id AS product_id,products.name,products.price,cart.quantity
     FROM cart JOIN products ON cart.product_id=products.id WHERE cart.user_id=$1`, [userId]
  );
  const cart = result.rows;
  const total = cart.reduce((sum, i) => sum + i.price*i.quantity,0);

  res.render("cart.ejs",{cart,total});
});

app.post("/add-to-cart", requireLogin, async (req,res)=>{
  const {productId} = req.body, uid=req.session.user.id;
  const exist=await db.query("SELECT * FROM cart WHERE user_id=$1 AND product_id=$2",[uid,productId]);
  exist.rows.length 
  ? await db.query("UPDATE cart SET quantity=quantity+1 WHERE user_id=$1 AND product_id=$2",[uid,productId])
  : await db.query("INSERT INTO cart(user_id,product_id,quantity) VALUES($1,$2,1)",[uid,productId]);
  res.redirect("/cart");
});

/*---------------------------------- STRIPE CHECKOUT ----------------------------------*/
app.get("/checkout", requireLogin, async (req,res)=>{
  const uid=req.session.user.id;
  const items=await db.query(
    `SELECT products.name,products.price,cart.quantity
     FROM cart JOIN products ON cart.product_id=products.id WHERE cart.user_id=$1`,[uid]
  );

  if(!items.rows.length) return res.send("Cart empty");

  const total = items.rows.reduce((sum,i)=>sum + i.price*i.quantity ,0);
  res.render("checkout.ejs",{cartItems:items.rows,total,totalCents:total*100});
});

app.post("/create-checkout-session", requireLogin, async (req,res)=>{
  const uid=req.session.user.id;
  const cart = await db.query(
    `SELECT products.name,products.price,cart.quantity
     FROM cart JOIN products ON cart.product_id=products.id WHERE user_id=$1`,[uid]
  );
  if(!cart.rows.length) return res.send("Cart empty");

  const session = await stripe.checkout.sessions.create({
    mode:"payment",
    payment_method_types:["card"],
    line_items: cart.rows.map(x=>({
      price_data:{
        currency:"usd",
        product_data:{name:x.name},
        unit_amount:x.price*100
      },
      quantity:x.quantity
    })),
    success_url:`${process.env.DOMAIN_URL}/success`,
    cancel_url:`${process.env.DOMAIN_URL}/cart`
  });

  res.redirect(session.url);
});

/*---------------------------------- SUCCESS PAGE ----------------------------------*/
app.get("/success",(req,res)=>{
  res.send("Payment Successful ✔️<br><a href='/products'>Continue Shopping</a>");
});

// Add raw parser only for /webhook
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.log('Webhook signature verification failed', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Handle event types you care about:
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    // TODO: mark order paid, clear cart, etc.
  }

  res.json({ received: true });
});

/*---------------------------------- SERVER ----------------------------------*/
app.listen(port,()=>console.log(`🚀 Server running on http://localhost:${port}`));
