const express = require("express");
const axios = require("axios");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json());

// ================= FIREBASE =================
admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  ),
});
const db = admin.firestore();

// ================= ZAPUPI =================
const TOKEN_KEY = "4b63fb4ebfbb9671aa5f47d6e3a49c21";
const SECRET_KEY = "a062630e79e1682b3e305c895f9f503c";

// ================= IMB =================
const IMB_API_TOKEN = process.env.IMB_API_TOKEN;

// ================= ROOT =================
app.get("/", (req, res) => {
  res.send("Backend running 🚀");
});

// =================================================
// CREATE PAYMENT (ZAPUPI)
// =================================================
app.post("/create-payment", async (req, res) => {
  try {
    const { userId, amount, mobile } = req.body;

    const orderId = "ORD" + Date.now();

    const response = await axios.post(
      "https://api.zapupi.com/api/create-order",
      new URLSearchParams({
        token_key: TOKEN_KEY,
        secret_key: SECRET_KEY,
        amount: Number(amount),
        order_id: orderId,
        custumer_mobile: mobile || "",
      }),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
      }
    );

    await db.collection("payments").doc(orderId).set({
      userId,
      amount: Number(amount),
      credited: false,
    });

    res.json({
      payment_url: response.data.payment_url,
      order_id: orderId,
    });

  } catch (err) {
    console.log("Zap Error:", err.response?.data || err.message);
    res.status(500).json({ error: "Zap failed" });
  }
});

// =================================================
// CREATE ORDER (IMB)
// =================================================
app.post("/create-order-imb", async (req, res) => {
  try {
    const { userId, amount, mobile } = req.body;

    const orderId = "IMB" + Date.now();

    const response = await axios.post(
      "https://secure-stage.imb.org.in/api/create-order",
      new URLSearchParams({
        customer_mobile: mobile,
        user_token: IMB_API_TOKEN,
        amount: Number(amount),
        order_id: orderId,
        redirect_url: "", // no redirect
        remark1: userId,
        remark2: "coins",
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    console.log("IMB RESPONSE:", response.data);

    const paymentUrl =
      response.data.payment_url ||
      response.data?.result?.payment_url;

    if (!paymentUrl) {
      return res.status(400).json({
        error: response.data || "Payment failed",
      });
    }

    await db.collection("payments").doc(orderId).set({
      userId,
      amount: Number(amount),
      credited: false,
    });

    res.json({
      payment_url: paymentUrl,
      order_id: orderId,
    });

  } catch (err) {
    console.log("🔥 IMB ERROR:", err.response?.data || err.message);

    res.status(500).json({
      error: err.response?.data || "Payment failed",
    });
  }
});

// =================================================
// VERIFY PAYMENT (IMB) → PRIMARY CREDIT METHOD
// =================================================
app.post("/verify-imb", async (req, res) => {
  try {
    const { orderId } = req.body;

    const response = await axios.get(
      `https://secure-stage.imb.org.in/api/order-status/${orderId}`
    );

    console.log("VERIFY RESPONSE:", response.data);

    const data = response.data;

    if (data.status !== "SUCCESS") {
      return res.json({ status: "pending" });
    }

    const ref = db.collection("payments").doc(orderId);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).json({ error: "Not found" });
    }

    const payment = snap.data();

    if (payment.credited) {
      return res.json({ status: "already_credited" });
    }

    // ✅ CREDIT COINS
    await db.collection("users").doc(payment.userId).update({
      wallet_balance: admin.firestore.FieldValue.increment(payment.amount),
    });

    await ref.update({ credited: true });

    console.log("✅ COINS CREDITED (VERIFY):", orderId);

    res.json({ status: "credited" });

  } catch (err) {
    console.log("VERIFY ERROR:", err.response?.data || err.message);
    res.status(500).json({ error: "Verification failed" });
  }
});

// =================================================
// WEBHOOK (AUTO BACKGROUND CREDIT)
// =================================================
app.post("/imb-webhook", async (req, res) => {
  try {
    console.log("🔥 WEBHOOK HIT:", req.body);

    const order_id = req.body.order_id || req.body.orderId;

    if (!order_id) return res.send("Invalid");

    // 🔥 VERIFY AGAIN FOR SAFETY
    const verifyRes = await axios.get(
      `https://secure-stage.imb.org.in/api/order-status/${order_id}`
    );

    if (verifyRes.data.status !== "SUCCESS") {
      return res.send("Not success");
    }

    const ref = db.collection("payments").doc(order_id);
    const snap = await ref.get();

    if (!snap.exists) return res.send("No payment");

    const payment = snap.data();

    if (payment.credited) return res.send("Already");

    await db.collection("users").doc(payment.userId).update({
      wallet_balance: admin.firestore.FieldValue.increment(payment.amount),
    });

    await ref.update({ credited: true });

    console.log("✅ COINS CREDITED (WEBHOOK):", order_id);

    res.send("Success");

  } catch (err) {
    console.log("❌ WEBHOOK ERROR:", err.response?.data || err.message);
    res.status(500).send("Error");
  }
});

// ================= START =================
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running 🚀");
});