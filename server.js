const express = require("express");
const axios = require("axios");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json());

/* =====================================
   🔐 FIREBASE INITIALIZATION
===================================== */

if (!process.env.FIREBASE_SERVICE_ACCOUNT) {
  console.error("FIREBASE_SERVICE_ACCOUNT is missing!");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  ),
});

const db = admin.firestore();

/* =====================================
   💳 CREATE PAYMENT
===================================== */

app.post("/create-payment", async (req, res) => {
  try {
    const { userId, amount, mobile } = req.body;

    // Validation
    if (!userId || !amount || amount < 10 || !mobile) {
      return res.status(400).json({
        error: "Invalid data. Minimum ₹10 required.",
      });
    }

    if (!process.env.SPACEPAY_PUBLIC_KEY || !process.env.SPACEPAY_SECRET_KEY) {
      console.error("Spacepay keys missing in environment!");
      return res.status(500).json({ error: "Payment configuration error" });
    }

    const orderId = "WALLET_" + Date.now();

    // Save payment as pending
    await db.collection("payments").doc(orderId).set({
      userId,
      amount,
      status: "pending",
      createdAt: new Date(),
    });

    // Call Spacepay API
    const response = await axios.post(
      "https://spacepay.in/api/payment/v1/pay",
      {
        public_key: process.env.SPACEPAY_PUBLIC_KEY,
        secret_key: process.env.SPACEPAY_SECRET_KEY,
        customer_mobile: mobile,
        amount: amount,
        order_id: orderId,
        redirect_url:
          "https://a47d-esports-backend.onrender.com/payment-success",
        note: "Wallet Top-up",
      }
    );

    console.log("Spacepay success response:", response.data);

    return res.json(response.data);
  } catch (error) {
    console.error("==== SPACEPAY ERROR FULL ====");
    console.error("Status:", error.response?.status);
    console.error("Data:", error.response?.data);
    console.error("Message:", error.message);

    return res.status(500).json({
      error: "Payment failed",
      details: error.response?.data || error.message,
    });
  }
});

/* =====================================
   🔔 SPACEPAY WEBHOOK
===================================== */

app.post("/webhook", async (req, res) => {
  try {
    const { order_id, status } = req.body;

    if (!order_id) {
      return res.status(400).send("Invalid webhook");
    }

    if (status === "SUCCESS") {
      const paymentRef = db.collection("payments").doc(order_id);
      const paymentDoc = await paymentRef.get();

      if (paymentDoc.exists && paymentDoc.data().status !== "success") {
        const { userId, amount } = paymentDoc.data();

        await db.collection("users").doc(userId).update({
          wallet_balance: admin.firestore.FieldValue.increment(amount),
        });

        await paymentRef.update({
          status: "success",
          updatedAt: new Date(),
        });

        console.log("Wallet credited:", userId, amount);
      }
    }

    return res.send("OK");
  } catch (error) {
    console.error("Webhook error:", error.message);
    return res.status(500).send("Error");
  }
});

/* =====================================
   🔁 PAYMENT SUCCESS REDIRECT
===================================== */

app.get("/payment-success", (req, res) => {
  // Android Deep Link
  res.redirect("a47d://a47d.com/payment-success");
});

/* =====================================
   🚀 START SERVER
===================================== */

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});