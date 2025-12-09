import express from "express";
import bodyParser from "body-parser";
import bcrypt from "bcrypt";
import dotenv from "dotenv";
import session from "express-session";
import passport from "passport";
import { Strategy as GoogleStrategy } from "passport-google-oauth20";
import pkg from "pg";
import multer from "multer";

const { Client } = pkg;

dotenv.config();

const app = express();
const port = process.env.PORT;;

import Stripe from "stripe" ; 
const stripe = new Stripe(process.env.STRIPE_SECRET, {
    apiVersion: "2022-11-15"
});

app.use(session({
    secret: process.env.MY_SECRET_KEY, // secret for signing session ID
    resave: false, // don’t save session if unmodified
    saveUninitialized: true,
    cookie:{
        maxAge: 100*60*60*24
    }  // don’t create session until something stored,}
}));



//middleware
app.use(bodyParser.urlencoded({extended:true}));
app.use(express.static("public"));

//middleware to protect routes
function requireLogin( req , res , next){
    if(!req.session.user){
        return res.redirect("/login");
    }
    next();
}

app.use((req, res, next) => { //middleware to make user available in all ejs templates
    res.locals.user = req.session.user;
    next();
});
 //admin
function requireAdmin(req, res, next) {
    console.log("Session user:", req.session.user);
    if (!req.session.user || !req.session.user.isAdmin) {
        return res.send("Access denied. Admins only.");
    }
    next();
}



//passport middleware
app.use(passport.initialize());
app.use(passport.session());

//datsabase
const db = new Client({
    user: process.env.PG_USER,
    host: process.env.PG_HOST,
    database: process.env.PG_DATABASE,
    password: process.env.PG_PASSWORD,
    port: process.env.PG_PORT
});
  db.connect();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, "public/images"),
  filename: (req, file, cb) => cb(null, Date.now() + "-" + file.originalname)
});

const upload = multer({ storage });

 
//temporary data 
let users=[] ;//store registered user account

//products available in store


//cart count globally avaialable
app.use((req, res, next) => {
    res.locals.cartCount = req.session.cart ? req.session.cart.length : 0;
    next();
});


app.get('/debug-session', (req, res) => {
    console.log('Session:', req.session);
    res.send(req.session);
});

app.get('/admin', requireAdmin, async (req, res) => {
    const result = await db.query("SELECT * FROM products ORDER BY id DESC");
    const products = result.rows;
   console.log("Session user:", req.session.user);
    res.render('admin.ejs', { products });

});
app.get('/admin/add-product', requireAdmin, (req, res) => {
    res.render('add-product.ejs');
});

app.post("/admin/add-product", requireAdmin, async (req, res) => {
    const { name, price, description, image } = req.body;

    await db.query(
        "INSERT INTO products(name, price, description, image) VALUES($1,$2,$3,$4)",
        [name, price, description, `/images/${image}`] // auto prepend folder path
    );

    res.redirect("/admin");
});


app.post("/admin/edit-product/:id", requireAdmin, upload.single("image"), async (req, res) => {
    const { id } = req.params;
    const { name, price, description } = req.body;

    const image = req.file ? req.file.filename : req.body.old_image; // keep old image if none uploaded

    await db.query(
        "UPDATE products SET name=$1, price=$2, description=$3, image=$4 WHERE id=$5",
        [name, price, description, image, id]
    );

    res.redirect("/admin");
});


app.get('/admin/edit-product/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const result = await db.query("SELECT * FROM products WHERE id=$1", [id]);
    res.render('edit-product.ejs', { product: result.rows[0] });
});

app.post('/admin/edit-product/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { name, price } = req.body;
    const image = req.body.image; // just filename like bag.png

    await db.query(
      "UPDATE products SET name=$1, price=$2, image=$3 WHERE id=$4",
      [name, price, image, id]
    );

    res.redirect("/admin");
});

app.post('/admin/delete-product/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;
    await db.query("DELETE FROM products WHERE id=$1", [id]);
    res.redirect('/admin');
});

 //homepage
 app.get("/", async (req, res) => {
    const result = await db.query("SELECT * FROM products");  // must run each time
    res.render("index.ejs", { products: result.rows });
});


 //authorization routes
 //signup
 app.get("/signup" , (req,res)=>{
    res.render("signup.ejs")
 })

app.post("/signup" , async (req,res)=>{
    const email = req.body.email;
    const password = req.body.password;

    const hashed = await bcrypt.hash(password,10) //10 times do salting
      await db.query(
        "INSERT INTO users(email, password) VALUES ($1, $2)",
        [email, hashed]
    );

    
    res.redirect("/login")
})



// GET login page
app.get("/login", (req, res) => {
    res.render("login.ejs");
});

//post login page

app.post("/login" , async(req,res)=>{
    const email = req.body.email;
    const password = req.body.password;
    //find user by email
  const result = await db.query(
        "SELECT * FROM users WHERE email=$1",
        [email]
    );

    if(result.rows.length === 0) 
        return res.send("User not found");

    const user = result.rows[0];

    const match = await bcrypt.compare(password, user.password);
    if(!match) return res.send("Wrong password");

    req.session.user = {
    id: user.id,
    email: user.email,
    isAdmin: user.is_admin === true || user.is_admin === 't' // make sure this column exists in your users table
        };
         console.log("Session set:", req.session.user);          
    res.redirect("/products");


});

// Login with Google
app.get('/auth/google',
    passport.authenticate('google', { scope: ['profile', 'email'] })
);

// Google Callback URL
app.get('/auth/google/callback',
    passport.authenticate("google", { failureRedirect: "/login" }),
    async (req, res) => {

        const googleId = req.user.id;
        const email = req.user.email;

                let result = await db.query(
            "SELECT * FROM users WHERE google_id=$1 OR email=$2",
            [googleId, email]
        );

        if(result.rows.length === 0) {
            await db.query(
                "INSERT INTO users(email, google_id) VALUES($1,$2)",
                [email, googleId]
            );
        }

        // Use the existing or newly inserted user
        const storedUser = result.rows.length > 0 ? result.rows[0] : 
            (await db.query("SELECT * FROM users WHERE google_id=$1", [googleId])).rows[0];

                req.session.user = {
                id: storedUser.id,
                email: storedUser.email,
                isAdmin: storedUser.is_admin === true || storedUser.is_admin === 't' || false
            };
        res.redirect("/products");
    });

//for 0Auth

passport.use(new GoogleStrategy({
    clientID: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    callbackURL: "http://localhost:3000/auth/google/callback"
}, 
function(accessToken, refreshToken, profile, done) {

    // store google user in session
    const user = { email: profile.emails[0].value, name: profile.displayName };
    return done(null, user);
}));

// serialize user → save in session
passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));


//show product page
app.get("/products", async (req, res) => {
    const result = await db.query("SELECT * FROM products");
    res.render("products.ejs", { products: result.rows });
});



app.post("/products" , (req,res)=>{
    res.render('products.ejs' , {products});
})



//add-to-cart session
app.post("/add-to-cart" , requireLogin ,async(req,res)=>{
 const { productId } = req.body;
    const userId = req.session.user.id;

    // Check if product already in cart
    const existing = await db.query(
        "SELECT * FROM cart WHERE user_id=$1 AND product_id=$2",
        [userId, productId]
    );

    if(existing.rows.length > 0){
        // If exists, increase quantity
        await db.query(
            "UPDATE cart SET quantity = quantity + 1 WHERE user_id=$1 AND product_id=$2",
            [userId, productId]
        );
    } else {
        // Else insert new row
        await db.query(
            "INSERT INTO cart(user_id, product_id, quantity) VALUES($1,$2,1)",
            [userId, productId]
        );
    }

    res.redirect('/cart');


})

//cart routes
app.get("/cart" , requireLogin,async (req,res)=>{ //go to cart but first login thats why suing middleware here
  const userId = req.session.user.id;

    // Join cart + products to get product info
    const result = await db.query(
        `SELECT cart.id AS cart_id, products.id AS product_id, products.name, products.price, cart.quantity
         FROM cart
         JOIN products ON cart.product_id = products.id
         WHERE cart.user_id=$1`,
        [userId]
    );

    const cartItems = result.rows;

    // Calculate total
    const total = cartItems.reduce((sum, item) => sum + item.price * item.quantity, 0);

    res.render('cart.ejs', { cart: cartItems, total });
});

//remove product from cart
app.post('/cart/remove', requireLogin, async (req,res)=>{
    const { cart_id } = req.body;
    await db.query("DELETE FROM cart WHERE id=$1", [cart_id]);
    res.redirect('/cart');
});


//update cart

app.post("/cart/update", requireLogin, async (req, res) => {
    const { cart_id, action } = req.body;

    if(action === "increment") {
        await db.query(
            "UPDATE cart SET quantity = quantity + 1 WHERE id=$1",
            [cart_id]
        );
    } else if(action === "decrement") {
        // Decrement, but don't go below 1
        const result = await db.query("SELECT quantity FROM cart WHERE id=$1", [cart_id]);
        if(result.rows.length > 0 && result.rows[0].quantity > 1){
            await db.query(
                "UPDATE cart SET quantity = quantity - 1 WHERE id=$1",
                [cart_id]
            );
        } else {
            // Optionally, remove the item if quantity would go below 1
            await db.query("DELETE FROM cart WHERE id=$1", [cart_id]);
        }
    }

    res.redirect("/cart");
});


//stripe payment
app.get("/checkout" ,requireLogin,async (req,res)=>{
    const userId = req.session.user.id;

    // Get cart items from DB
    const result = await db.query(
        `SELECT cart.id AS cart_id, products.id AS product_id, products.name, products.price, cart.quantity
         FROM cart
         JOIN products ON cart.product_id = products.id
         WHERE cart.user_id=$1`,
        [userId]
    );

    const cartItems = result.rows;

    if(cartItems.length === 0) return res.send("Your cart is empty!");

    // ✅ Fix: keep total in dollars for display
    const totalDollars = cartItems.reduce((sum, item) => sum + item.price * item.quantity, 0);

    // totalCents will be used when creating Stripe session
    const totalCents = totalDollars * 100;

    // Render checkout page with total in dollars
    res.render('checkout.ejs', { total: totalDollars, cartItems, totalCents });
})

app.post("/pay", requireLogin, async (req, res) => {
    const userId = req.session.user.id;

    const result = await db.query(
        `SELECT cart.id AS cart_id, products.id AS product_id, products.name, products.price, cart.quantity
         FROM cart
         JOIN products ON cart.product_id = products.id
         WHERE cart.user_id=$1`,
        [userId]
    );

    const cart = result.rows;
    if(cart.length === 0) return res.send("Cart is empty");

    const total = cart.reduce((sum, item) => sum + item.price * item.quantity, 0);

    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: cart.map(item => ({
                price_data: {
                    currency: 'usd',
                    product_data: { name: item.name },
                    unit_amount: item.price * 100
                },
                quantity: item.quantity
            })),
            mode: "payment",
            success_url: "http://localhost:3000/success",
            cancel_url: "http://localhost:3000/cart"
        });

        res.redirect(session.url);

    } catch (err) {
        console.log(err);
        res.send("Stripe error: " + err.message);
    }
});


app.get("/success", requireLogin, async (req, res) => {
     const userId = req.session.user.id;

    // Get cart items
    const result = await db.query(
        `SELECT products.id, products.price, cart.quantity
         FROM cart
         JOIN products ON cart.product_id = products.id
         WHERE cart.user_id=$1`,
        [userId]
    );

    const cartItems = result.rows;
    const total = cartItems.reduce((sum, item) => sum + item.price * item.quantity, 0);

    // Save order
    await db.query(
        "INSERT INTO orders(user_id, total) VALUES($1,$2)",
        [userId, total]
    );

    // Clear cart
    await db.query("DELETE FROM cart WHERE user_id=$1", [userId]);

    res.render('success.ejs');
});

//logout route
app.get("/logout" , (req,res)=>{
    req.session.destroy();
    res.redirect("/login")
})

//port
app.listen(port , ()=>{
    console.log(`app is running on ${port}`);
});

