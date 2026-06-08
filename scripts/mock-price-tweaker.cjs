const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const port = Number(process.env.MOCK_PRICE_TWEAKER_PORT || 7788);
const stepFixturePath = process.env.STEP_FIXTURE_PATH || path.resolve(process.cwd(), "cutting-blade-1-k110-1.STEP");

let calls = [];

app.use(express.json({ limit: "2mb" }));

app.get("/health", (_req, res) => {
  res.json({ success: true, port, stepFixturePath });
});

app.get("/files/cutting-blade-1-k110-1.STEP", (_req, res) => {
  if (!fs.existsSync(stepFixturePath)) {
    res.status(404).json({ error: "STEP fixture not found", stepFixturePath });
    return;
  }

  res.setHeader("Content-Type", "model/step");
  res.setHeader("Cache-Control", "no-store");
  fs.createReadStream(stepFixturePath).pipe(res);
});

app.delete("/mock/price-tweaking/calls", (_req, res) => {
  calls = [];
  res.json({ success: true });
});

app.get("/mock/price-tweaking/calls", (_req, res) => {
  res.json({ success: true, calls });
});

app.post("/mock/price-tweaking", (req, res) => {
  const payload = req.body || {};
  const record = {
    receivedAt: new Date().toISOString(),
    payload,
  };

  calls.push(record);

  res.json({
    success: true,
    code: "mock_price_tweak_received",
    object_model_id: 90210,
    order_id: 712,
    session_id: "mock-session-001",
    status: "accepted",
    received_count: calls.length,
  });
});

app.listen(port, "127.0.0.1", () => {
  console.log(`mock-price-tweaker listening on http://127.0.0.1:${port}`);
});
