const express = require("express");
const axios = require("axios");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json());

// ================= FIREBASE INIT =================
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
const IMB_BASE_URL = "https://secure-stage.imb.org.in/";

// =================================================
// HEALTH CHECK
// =================================================
app.get("/", (req, res) => {
  res.send("Backend Running");
});

// =================================================
// CREATE PAYMENT (ZAPUPI)
// =================================================
app.post("/create-payment", async (req, res) => {
  try {
    const { userId, amount, mobile } = req.body;

    if (!userId || !amount) {
      return res.status(400).json({ error: "Missing data" });
    }

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
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    if (response.data.status !== "success") {
      return res.status(400).json({ error: response.data.message });
    }

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

  } catch (err) {
    console.log("Error:", err.message);
    res.status(500).json({ error: "Payment failed" });
  }
});

// =================================================
// VERIFY PAYMENT (ZAPUPI)
// =================================================
app.post("/verify-payment", async (req, res) => {
  try {
    const { orderId } = req.body;

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
      return res.json({ status: "pending" });
    }

    const ref = db.collection("payments").doc(orderId);
    const snap = await ref.get();

    if (!snap.exists) {
      return res.status(404).json({ error: "Not found" });
    }

    const data = snap.data();

    if (data.credited) {
      return res.json({ status: "already_credited" });
    }

    await db.collection("users").doc(data.userId).update({
      wallet_balance: admin.firestore.FieldValue.increment(data.amount),
    });

    await ref.update({ credited: true });

    res.json({ status: "credited" });

  } catch (err) {
    res.status(500).json({ error: "Verification failed" });
  }
});

// =================================================
// CREATE ORDER (IMB)  ✅ FIXED
// =================================================
app.post("/create-order-imb", async (req, res) => {
  try {
    const { userId, amount, mobile } = req.body;

    if (!userId || !amount) {
      return res.status(400).json({ error: "Missing data" });
    }

    const orderId = "IMB" + Date.now();

    const response = await axios.post(
      `${IMB_BASE_URL}api/create-order`,
      {
        order_id: orderId,
        amount: Number(amount), // ✅ FIXED (no toFixed)
        customer_mobile: mobile || "",
        redirect_url: "https://a47d.flutterflow.app/success"
      },
      {
        headers: {
          Authorization: `Bearer ${IMB_API_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("IMB RESPONSE:", response.data);

    const paymentUrl =
      response.data.payment_url ||
      response.data?.data?.payment_url;

    if (!paymentUrl) {
      return res.status(400).json({ error: "Payment failed" });
    }

    await db.collection("payments").doc(orderId).set({
      userId,
      amount: Number(amount),
      credited: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({
      payment_url: paymentUrl,
      order_id: orderId,
    });

  } catch (err) {
    console.log("IMB Error:", err.response?.data || err.message);
    res.status(500).json({ error: "Payment failed" });
  }
});

// =================================================
// VERIFY PAYMENT (IMB)
// =================================================
app.post("/verify-imb", async (req, res) => {
  try {
    const { orderId } = req.body;

    const response = await axios.get(
      `${IMB_BASE_URL}api/order-status/${orderId}`,
      {
        headers: {
          Authorization: `Bearer ${IMB_API_TOKEN}`,
        },
      }
    );

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

    await db.collection("users").doc(payment.userId).update({
      wallet_balance: admin.firestore.FieldValue.increment(
        payment.amount
      ),
    });

    await ref.update({ credited: true });

    res.json({ status: "credited" });

  } catch (err) {
    res.status(500).json({ error: "Verification failed" });
  }
});

// =================================================
// WEBHOOK (IMB)
// =================================================
app.post("/imb-webhook", async (req, res) => {
  try {
    const order_id = req.body.order_id;
    const status = req.body.status;

    if (!order_id || status !== "SUCCESS") {
      return res.send("Ignored");
    }

    const ref = db.collection("payments").doc(order_id);
    const snap = await ref.get();

    if (!snap.exists) return res.send("No payment");

    const data = snap.data();

    if (data.credited) return res.send("Already");

    await db.collection("users").doc(data.userId).update({
      wallet_balance: admin.firestore.FieldValue.increment(data.amount),
    });

    await ref.update({ credited: true });

    res.send("Success");

  } catch (err) {
    res.status(500).send("Error");
  }
});

// =================================================
// START SERVER
// =================================================
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});