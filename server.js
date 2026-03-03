const express = require("express");
const axios = require("axios");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ================= FIREBASE INIT =================
admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  ),
});

const db = admin.firestore();

// ================= ZAPUPI KEYS =================
const TOKEN_KEY = "4b63fb4ebfbb9671aa5f47d6e3a49c21";
const SECRET_KEY = "a062630e79e1682b3e305c895f9f503c";

// =================================================
// HEALTH CHECK (FOR RENDER)
// =================================================
app.get("/", (req, res) => {
  res.send("Backend is running");
});

// =================================================
// CREATE PAYMENT
// =================================================
app.post("/create-payment", async (req, res) => {
  try {
    const { userId, amount, mobile } = req.body;

    if (!userId || !amount) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const orderId = "ORD" + Date.now();

    const response = await axios.post(
      "https://api.zapupi.com/api/create-order",
      new URLSearchParams({
        token_key: TOKEN_KEY,
        secret_key: SECRET_KEY,
        amount: amount,
        order_id: orderId,
        custumer_mobile: mobile || "",
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    if (response.data.status !== "success") {
      return res.status(400).json({ error: response.data.message });
    }

    // Save payment in Firestore
    await db.collection("payments").doc(orderId).set({
      userId,
      amount: Number(amount),
      credited: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({
      payment_url: response.data.payment_url,
      order_id: orderId,
    });
  } catch (error) {
    console.error("Create Payment Error:", error.response?.data || error.message);
    res.status(500).json({ error: "Payment creation failed" });
  }
});

// =================================================
// VERIFY PAYMENT (Manual Fallback)
// =================================================
app.post("/verify-payment", async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ error: "Missing orderId" });
    }

    const response = await axios.post(
      "https://api.zapupi.com/api/order-status",
      new URLSearchParams({
        token_key: TOKEN_KEY,
        secret_key: SECRET_KEY,
        order_id: orderId,
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    if (response.data.status !== "success") {
      return res.status(400).json({ error: "Payment not successful" });
    }

    const paymentRef = db.collection("payments").doc(orderId);
    const paymentSnap = await paymentRef.get();

    if (!paymentSnap.exists) {
      return res.status(404).json({ error: "Payment record not found" });
    }

    const paymentData = paymentSnap.data();

    if (paymentData.credited) {
      return res.json({ status: "already_credited" });
    }

    await db.collection("users").doc(paymentData.userId).update({
      wallet_balance: admin.firestore.FieldValue.increment(paymentData.amount),
    });

    await paymentRef.update({ credited: true });

    res.json({ status: "credited" });
  } catch (error) {
    console.error("Verify Error:", error.response?.data || error.message);
    res.status(500).json({ error: "Verification failed" });
  }
});

// =================================================
// WEBHOOK (AUTO CREDIT)
// =================================================
app.post("/zap-webhook", async (req, res) => {
  try {
    console.log("Webhook Received:", req.body);

    const { order_id, status } = req.body;

    if (status !== "success") {
      return res.send("Ignored");
    }

    const paymentRef = db.collection("payments").doc(order_id);
    const paymentSnap = await paymentRef.get();

    if (!paymentSnap.exists) {
      return res.status(404).send("Payment not found");
    }

    const paymentData = paymentSnap.data();

    if (paymentData.credited) {
      return res.send("Already credited");
    }

    await db.collection("users").doc(paymentData.userId).update({
      wallet_balance: admin.firestore.FieldValue.increment(paymentData.amount),
    });

    await paymentRef.update({ credited: true });

    res.send("Coins credited");
  } catch (error) {
    console.error("Webhook Error:", error.response?.data || error.message);
    res.status(500).send("Error");
  }
});

// =================================================
// START SERVER
// =================================================
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});