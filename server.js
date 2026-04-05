const express = require("express");
const axios = require("axios");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json());

// 🔥 FIREBASE
admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  ),
});
const db = admin.firestore();

// 🔥 ZAPUPI
const TOKEN_KEY = "4b63fb4ebfbb9671aa5f47d6e3a49c21";
const SECRET_KEY = "a062630e79e1682b3e305c895f9f503c";

// 🔥 IMB
const IMB_API_TOKEN = process.env.IMB_API_TOKEN;

// ================= ROOT =================
app.get("/", (req, res) => {
  res.send("Backend running 🚀");
});

// ================= ZAP CREATE =================
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
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
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
    res.status(500).json({ error: "Zap failed" });
  }
});

// ================= IMB CREATE =================
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
        redirect_url: "https://a47d.flutterflow.app/success",
        remark1: userId,
        remark2: "coins"
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
        error: response.data || "Payment failed"
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
    console.log("🔥 IMB ERROR:", err.response?.data);

    res.status(500).json({
      error: err.response?.data || "Payment failed"
    });
  }
});

// ================= WEBHOOK =================
app.post("/imb-webhook", async (req, res) => {
  try {
    const { order_id, status } = req.body;

    if (status !== "SUCCESS") return res.send("Ignored");

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

  } catch {
    res.status(500).send("Error");
  }
});

// ================= START =================
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Server running 🚀"));