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

// ================= TRANZUPI TOKEN =================
const USER_TOKEN = "35025ffc5d8d5afc760c6bb54de30c8a";

// =================================================
// HEALTH CHECK
// =================================================
app.get("/", (req, res) => {
  res.send("Tranzupi Backend Running");
});

// =================================================
// CREATE PAYMENT
// =================================================
app.post("/create-payment", async (req, res) => {
  try {
    const { userId, amount, mobile } = req.body;

    if (!userId || !amount) {
      return res.status(400).json({ error: "Missing userId or amount" });
    }

    const orderId = "ORD" + Date.now();

    const response = await axios.post(
      "https://tranzupi.com/api/create-order",
      {
        customer_mobile: mobile || "9999999999",
        user_token: USER_TOKEN,
        amount: amount,
        order_id: orderId,
        redirect_url:
          "https://a47d-esports-backend-1.onrender.com/payment-success",
        remark1: userId,
        remark2: "A47D Coins",
      }
    );

    if (!response.data.status) {
      return res.status(400).json({
        error: response.data.message || "Tranzupi error",
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
      payment_url: response.data.result.payment_url,
      order_id: orderId,
    });
  } catch (error) {
    console.error(
      "Create Payment Error:",
      error.response?.data || error.message
    );
    return res.status(500).json({ error: "Payment creation failed" });
  }
});

// =================================================
// TRANZUPI WEBHOOK
// =================================================
app.post("/tranzupi-webhook", async (req, res) => {
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
      wallet_balance: admin.firestore.FieldValue.increment(
        paymentData.amount
      ),
    });

    await paymentRef.update({ credited: true });

    return res.send("Coins credited successfully");
  } catch (error) {
    console.error("Webhook Error:", error.message);
    return res.status(500).send("Webhook error");
  }
});

// =================================================
// SUCCESS PAGE
// =================================================
app.get("/payment-success", (req, res) => {
  res.send("Payment successful. Return to the app.");
});

// =================================================
// START SERVER
// =================================================
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});