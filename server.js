const express = require("express");
const axios = require("axios");
const cors = require("cors");
const admin = require("firebase-admin");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ================= FIREBASE =================
admin.initializeApp({
  credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  ),
});
const db = admin.firestore();

// ================= IMB =================
const IMB_API_TOKEN = process.env.IMB_API_TOKEN;
const IMB_BASE_URL = "https://secure-stage.imb.org.in/api";

// ================= PUSH FUNCTION =================
const sendPush = async (token, title, body) => {
  try {
    await admin.messaging().send({
      token: token,
      notification: {
        title: title,
        body: body,
      },
    });
  } catch (err) {
    console.log("Push Error:", err.message);
  }
};

// ================= ROOT =================
app.get("/", (req, res) => {
  res.send("Backend running 🚀");
});

// =================================================
// CREATE ORDER
// =================================================
app.post("/create-order-imb", async (req, res) => {
  try {
    const { userId, amount, mobile } = req.body;

    const orderId = "IMB" + Date.now();

    const response = await axios.post(
      `${IMB_BASE_URL}/create-order`,
      new URLSearchParams({
        customer_mobile: mobile,
        user_token: IMB_API_TOKEN,
        amount: Number(amount),
        order_id: orderId,
        redirect_url: "",
        remark1: userId,
        remark2: "coins",
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
      }
    );

    const paymentUrl =
      response.data.payment_url ||
      response.data?.result?.payment_url;

    if (!paymentUrl) {
      return res.status(400).json({ error: "Payment failed" });
    }

    await db.collection("payments").doc(orderId).set({
      userId,
      amount: Number(amount),
      credited: false,
      status: "PENDING",
      createdAt: new Date(),
    });

    res.json({
      payment_url: paymentUrl,
      order_id: orderId,
    });

  } catch (err) {
    console.error("CREATE ORDER ERROR:", err.message);
    res.status(500).json({ error: "Create order failed" });
  }
});

// =================================================
// VERIFY IMB
// =================================================
const verifyIMBPayment = async (orderId) => {
  const response = await axios.post(
    `${IMB_BASE_URL}/check-order-status`,
    new URLSearchParams({
      user_token: IMB_API_TOKEN,
      order_id: orderId,
    }),
    {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );

  const apiStatus = response.data.status;
  const txnStatus = response.data?.result?.txnStatus;

  return {
    success: apiStatus === "SUCCESS" && txnStatus === "COMPLETED",
    raw: response.data,
  };
};

// =================================================
// CREDIT FUNCTION + PUSH
// =================================================
const creditCoinsIfNeeded = async (orderId) => {
  const ref = db.collection("payments").doc(orderId);
  const snap = await ref.get();

  if (!snap.exists) return "no_payment";

  const payment = snap.data();

  if (payment.credited) return "already";

  const verify = await verifyIMBPayment(orderId);

  if (!verify.success) {
    return "pending";
  }

  // ✅ CREDIT USER
  await db.collection("users").doc(payment.userId).update({
    wallet_balance: admin.firestore.FieldValue.increment(payment.amount),
  });

  // ✅ MARK PAYMENT
  await ref.update({
    credited: true,
    status: "SUCCESS",
    updatedAt: new Date(),
  });

  // 🔥 SEND PUSH NOTIFICATION
  try {
    const userDoc = await db.collection("users").doc(payment.userId).get();
    const token = userDoc.data()?.fcm_token;

    if (token) {
      await sendPush(
        token,
        "Payment Successful 🎉",
        "Coins have been added to your wallet."
      );
    }
  } catch (err) {
    console.log("Push after credit failed:", err.message);
  }

  return "credited";
};

// =================================================
// CHECK STATUS
// =================================================
app.get("/check-payment-status", async (req, res) => {
  try {
    const { orderId } = req.query;

    if (!orderId) {
      return res.status(400).json({ error: "Missing orderId" });
    }

    const result = await creditCoinsIfNeeded(orderId);

    res.json({ status: result });

  } catch (err) {
    console.error("CHECK STATUS ERROR:", err.message);
    res.status(500).json({ error: "Failed" });
  }
});

// =================================================
// VERIFY (MANUAL)
// =================================================
app.post("/verify-imb", async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ error: "Missing orderId" });
    }

    const result = await creditCoinsIfNeeded(orderId);

    res.json({ status: result });

  } catch (err) {
    console.error("VERIFY ERROR:", err.message);
    res.status(500).json({ error: "Verification failed" });
  }
});

// =================================================
// WEBHOOK
// =================================================
app.post("/imb-webhook", async (req, res) => {
  try {
    console.log("🔥 WEBHOOK:", req.body);

    const orderId =
      req.body.order_id ||
      req.body.orderId ||
      req.body?.result?.orderId;

    if (!orderId) {
      return res.status(200).send("No orderId");
    }

    let result = "pending";

    for (let i = 0; i < 3; i++) {
      result = await creditCoinsIfNeeded(orderId);

      if (result === "credited" || result === "already") {
        break;
      }

      await new Promise((r) => setTimeout(r, 2000));
    }

    console.log("WEBHOOK FINAL RESULT:", result);

    res.status(200).send("OK");

  } catch (err) {
    console.error("WEBHOOK ERROR:", err.message);
    res.status(200).send("ERROR");
  }
});

// =================================================
// 🔥 GLOBAL NOTIFICATION API
// =================================================
app.post("/send-notification", async (req, res) => {
  try {
    const { title, body } = req.body;

    const users = await db.collection("users").get();

    for (const doc of users.docs) {
      const token = doc.data().fcm_token;

      if (token) {
        await sendPush(token, title, body);
      }
    }

    res.json({ message: "Notification sent" });

  } catch (err) {
    console.error("SEND NOTIFICATION ERROR:", err.message);
    res.status(500).json({ error: "Failed" });
  }
});

// ================= START =================
const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log("Server running 🚀 on port", PORT);
});