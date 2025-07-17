// server.js – full backend (Razorpay + sales + KPI)
require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const mysql    = require('mysql2/promise');
//const Razorpay = require('razorpay');
const crypto   = require('crypto');
const bcrypt   = require('bcrypt');         // ✅ Required for password hashing
const jwt      = require('jsonwebtoken');   // ✅ Required for JWT login

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname,'public')));

/* ─── MySQL ─── */
const pool = mysql.createPool({
  host:'localhost',
  user:'root',
  password:'',             // ← replace with your MySQL password if any
  database:'millet_db',    // ← ✅ updated from 'millet' to 'millet_db'
  waitForConnections:true,
  connectionLimit:10
});
console.log('🟢 Connected to MySQL');

/* ─── Razorpay ─── */
/*const razor = new Razorpay({
  key_id:     process.env.RAZOR_KEY_ID,
  key_secret: process.env.RAZOR_KEY_SECRET
});
*/
/* ---------------- LOGIN (Admin) ---------------- */
app.post('/login', async (req,res) => {
  try {
    const {username, password} = req.body;
    const [r] = await pool.query(
      'SELECT userType FROM users WHERE username=? AND password=?',
      [username, password]
    );
    r.length
      ? res.json({ success: true, userType: r[0].userType })
      : res.json({ success: false, message: 'Invalid credentials' });
  } catch (err) {
    console.error('LOGIN ERROR:', err);
    res.status(500).json({ message: 'Internal Server Error' });
  }
});

/* ---------------- ADD WAREHOUSE ---------------- */
// Add Warehouse (admin creates login)
app.post('/api/warehouse', async (req, res) => {
  const { name, city, email, password } = req.body;
  if (!name || !city || !email || !password) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const hashed = await bcrypt.hash(password, 10);

    // ✅ Use pool.query instead of connection.query
    await pool.query(
      'INSERT INTO warehouses (name, city, email, password) VALUES (?, ?, ?, ?)',
      [name, city, email, hashed]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('❌ Error adding warehouse:', err);
    res.status(500).json({ error: 'Server error or duplicate email' });
  }
});

/* ---------------- WAREHOUSE LOGIN ---------------- */
app.post('/api/warehouse', async (req, res) => {
  const { name, city, email, password } = req.body;
  if (!name || !city || !email || !password) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const hashed = await bcrypt.hash(password, 10);
    await pool.query(
      'INSERT INTO warehouses (name, city, email, password) VALUES (?, ?, ?, ?)',
      [name, city, email, hashed]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Error adding warehouse:', err);
    res.status(500).json({ error: 'Server error or duplicate email' });
  }
});

/* --------------- PRODUCT --------------- */
app.post('/api/product', async (req,res)=>{
  const {name,sku,barcode,unit,price,qty=0}=req.body;
  const c=await pool.getConnection();
  try{
    await c.beginTransaction();
    const [p]=await c.query(
      'INSERT INTO products (name,sku,barcode,unit,price) VALUES (?,?,?,?,?)',
      [name,sku,barcode,unit,price]);
    await c.query('INSERT INTO inventory (product_id,quantity) VALUES (?,?)',[p.insertId,qty]);
    await c.commit();
    res.json({id:p.insertId,name,sku,barcode,unit,price,qty});
  }catch(err){await c.rollback();console.error(err);res.status(500).json({msg:'DB error'});}
  finally{c.release();}
});

app.get('/api/products', async (_req,res)=>{
  const [rows]=await pool.query('SELECT id,sku,name FROM products ORDER BY sku');
  res.json(rows);
});

/* --------------- INVENTORY -------------- */
app.get('/api/inventory', async (_req,res)=>{
  const [rows]=await pool.query(`
    SELECT p.id,p.sku,p.name,i.quantity
    FROM products p JOIN inventory i ON i.product_id=p.id`);
  res.json(rows);
});

app.post('/api/inventory/update', async (req,res)=>{
  const {productId,delta}=req.body;
  await pool.query('UPDATE inventory SET quantity=quantity+? WHERE product_id=?',[delta,productId]);
  const [[r]]=await pool.query('SELECT quantity FROM inventory WHERE product_id=?',[productId]);
  res.json({productId,quantity:r.quantity});
});

/* --------------- ORDER ------------------ */
app.post('/api/order', async (req,res)=>{
  const { distributor, items, payment_mode='cod', status='pending' } = req.body;
  const c = await pool.getConnection();
  try{
    await c.beginTransaction();

    const [o]=await c.query(
      'INSERT INTO orders (distributor,payment_mode,status) VALUES (?,?,?)',
      [distributor,payment_mode,status]);
    const orderId = o.insertId;

    const [pRows] = await pool.query(
      'SELECT id,price FROM products WHERE id IN (?)',
      [items.map(i=>i.productId)]
    );
    const priceMap = Object.fromEntries(pRows.map(r=>[r.id, r.price]));

    const vals = items.map(it=>[
      orderId, it.productId, it.qty, priceMap[it.productId]
    ]);
    await c.query(
      'INSERT INTO order_items (order_id,product_id,qty,mrp) VALUES ?', [vals]);

    await c.commit();
    res.json({id:orderId,distributor,payment_mode,payment_status:'pending',status});
  }catch(err){await c.rollback();console.error(err);res.status(500).json({msg:'DB error'});}
  finally{c.release();}
});

/* --------------- Razorpay --------------- */
/*app.post('/api/pay/init', async (req,res)=>{
  const { orderId, amount } = req.body;
  try{
    const rpOrder = await razor.orders.create({
      amount: Math.round(amount*100), currency:'INR', receipt:'OID_'+orderId
    });
    await pool.query(
      'INSERT INTO payments (order_id,rp_order_id,amount) VALUES (?,?,?)',
      [orderId, rpOrder.id, amount]);
    res.json({ key:process.env.RAZOR_KEY_ID, rpOrderId:rpOrder.id, amount });
  }catch(err){console.error(err); res.status(500).json({msg:'Razorpay error'});}
});

app.post('/webhook/razorpay', express.raw({type:'application/json'}), async (req,res)=>{
  const sig=req.headers['x-razorpay-signature'];
  const hash=crypto.createHmac('sha256',process.env.RAZOR_WEBHOOK_SECRET)
                   .update(req.body).digest('hex');
  if(sig===hash){
    const evt=JSON.parse(req.body);
    if(evt.event==='payment.captured'){
      const rpId = evt.payload.payment.entity.order_id;
      await pool.query('UPDATE payments SET status="paid" WHERE rp_order_id=?',[rpId]);
      await pool.query(`UPDATE orders SET payment_status='paid'
        WHERE id=(SELECT order_id FROM payments WHERE rp_order_id=? LIMIT 1)`,[rpId]);
    }
  }
  res.sendStatus(200);
});*/

/* --------------- ORDERS list & status ---- */
app.get('/api/order/:username', async (req,res)=>{
  const {username}=req.params;
  const [orders]=await pool.query(
    'SELECT id,status,payment_mode,payment_status,updated_at FROM orders WHERE distributor=? ORDER BY id DESC',[username]);
  for(const o of orders){
    const [items]=await pool.query(`
      SELECT p.sku,p.name,oi.qty
      FROM order_items oi JOIN products p ON p.id=oi.product_id
      WHERE oi.order_id=?`,[o.id]);
    o.items=items;
  }
  res.json(orders);
});

app.put('/api/order/:id/status', async (req,res)=>{
  const {status}=req.body; const {id}=req.params;
  await pool.query('UPDATE orders SET status=? WHERE id=?',[status,id]);
  res.json({id,status});
});

/* recent orders */
app.get('/api/orders/recent', async (_,_res)=>{
  const [rows]=await pool.query(`
    SELECT id,distributor,status,updated_at
    FROM orders ORDER BY updated_at DESC LIMIT 10`);
  _res.json(rows);
});

/* orders per day */
app.get('/api/orders/stats', async (_,_res)=>{
  const [rows]=await pool.query(`
    SELECT DATE(updated_at) AS day, COUNT(*) AS cnt
    FROM orders
    WHERE updated_at >= CURDATE() - INTERVAL 13 DAY
    GROUP BY day ORDER BY day`);
  _res.json(rows);
});

/* ===========================================================
   SALES MODULE
=========================================================== */
app.post('/api/sales', async (req,res)=>{
  const { distributor, productId, qty, discount=0 } = req.body;
  const [[p]] = await pool.query('SELECT price FROM products WHERE id=?',[productId]);
  if(!p) return res.status(404).json({msg:'Product not found'});
  await pool.query(
    'INSERT INTO sales (distributor,product_id,qty,mrp,discount) VALUES (?,?,?,?,?)',
    [distributor, productId, qty, p.price, discount]);
  res.json({success:true});
});

app.get('/api/sales/:user', async (req,res)=>{
  const {user}=req.params;
  const [rows]=await pool.query(`
    SELECT s.id, p.sku, p.name, s.qty, s.mrp, s.discount, s.sold_at
    FROM sales s JOIN products p ON p.id=s.product_id
    WHERE s.distributor=? ORDER BY s.id DESC`,[user]);
  res.json(rows);
});

/* ---------- Distributor KPI ---------- */
app.get('/api/stats/distributor/:user', async (req,res)=>{
  const user = req.params.user;

  const [buy] = await pool.query(`
    SELECT
      COALESCE(SUM(oi.qty),0)            AS buyQty,
      COALESCE(SUM(oi.qty*oi.mrp),0)     AS buyCost
    FROM orders o
    JOIN order_items oi ON oi.order_id = o.id
    WHERE o.distributor=? AND o.status IN ('shipped','delivered')`,
    [user]);

  const [sell] = await pool.query(`
    SELECT
      COALESCE(SUM(qty),0)         AS soldQty,
      COALESCE(SUM(qty*mrp),0)     AS revenue,
      COALESCE(SUM(discount),0)    AS totDisc
    FROM sales WHERE distributor=?`, [user]);

  const stock  = buy[0].buyQty - sell[0].soldQty;
  const profit = sell[0].revenue - sell[0].totDisc - buy[0].buyCost;

  res.json({
    stock,
    revenue : sell[0].revenue,
    discount: sell[0].totDisc,
    cost    : buy[0].buyCost,
    profit
  });
});

/* ---------- start ---------- */
const PORT = process.env.PORT || 3001;
app.listen(PORT, ()=>console.log(`✅ Server running at http://localhost:${PORT}`));

