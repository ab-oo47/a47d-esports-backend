const express = require("express");
const axios = require("axios");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// =================================================
// FIREBASE INIT (FROM RENDER ENV VARIABLE)
// =================================================
if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("FIREBASE_SERVICE_ACCOUNT not set");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  ),
});

const db = admin.firestore();

// =================================================
// ZAPUPI KEYS
// (Better to move these to ENV later for security)
// =================================================
const TOKEN_KEY = "4b63fb4ebfbb9671aa5f47d6e3a49c21";
const SECRET_KEY = "a062630e79e1682b3e305c895f9f503c";

// =================================================
// HEALTH CHECK ROUTE
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

    const zapResponse = await axios.post(
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

    if (zapResponse.data.status !== "success") {
      return res.status(400).json({
        error: zapResponse.data.message || "Zap order failed",
      });
    }

    // Save payment record
    await db.collection("payments").doc(orderId).set({
      userId,
      amount: Number(amount),
      credited: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({
      payment_url: zapResponse.data.payment_url,
      order_id: orderId,
    });

  } catch (error) {
    console.error("Create Payment Error:", error.response?.data || error.message);
    return res.status(500).json({ error: "Payment creation failed" });
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

    const zapResponse = await axios.post(
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

    if (zapResponse.data.status !== "success") {
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

    // Credit coins
    const userRef = db.collection("users").doc(paymentData.userId);

    await userRef.update({
      coins: admin.firestore.FieldValue.increment(paymentData.amount),
    });

    await paymentRef.update({
      credited: true,
      verifiedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.json({ status: "credited" });

  } catch (error) {
    console.error("Verify Error:", error.response?.data || error.message);
    return res.status(500).json({ error: "Verification failed" });
  }
});

// =================================================
// ZAPUPI WEBHOOK (INSTANT AUTO CREDIT)
// =================================================
app.post("/zap-webhook", async (req, res) => {
  try {
    console.log("Webhook Received:", req.body);

    const { order_id, status } = req.body;

    if (!order_id || status !== "success") {
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

    const userRef = db.collection("users").doc(paymentData.userId);

    await userRef.update({
      coins: admin.firestore.FieldValue.increment(paymentData.amount),
    });

    await paymentRef.update({
      credited: true,
      webhookAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return res.send("Coins credited");

  } catch (error) {
    console.error("Webhook Error:", error.message);
    return res.status(500).send("Error");
  }
});

// =================================================
// SERVER START (RENDER SAFE)
// =================================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});