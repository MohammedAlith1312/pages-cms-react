import { Router, Request, Response } from "express";
import crypto from "crypto";

import { handleInstallationWebhookEvent } from "../lib/github-webhook-installation";
import { handlePushWebhookEvent } from "../lib/github-webhook-push";
import { handleActionWebhookEvent } from "../lib/github-webhook-actions";

const router = Router();

/* ==========================================
   11. GITHUB WEBHOOK ENDPOINT
   ========================================== */
router.post("/api/webhook/github", async (req: Request, res: Response) => {
  try {
    const signature = req.headers["x-hub-signature-256"] as string;
    const event = req.headers["x-github-event"] as string;

    // Access the raw body captured by express.json verification
    const bodyStr = (req as any).rawBody ? (req as any).rawBody.toString("utf8") : "";

    const secret = process.env.GITHUB_APP_WEBHOOK_SECRET;
    if (!secret) {
      console.error("Missing GITHUB_APP_WEBHOOK_SECRET");
      return res.status(500).json(null);
    }

    const hmac = crypto.createHmac("sha256", secret);
    const digest = `sha256=${hmac.update(bodyStr).digest("hex")}`;
    if (!signature) return res.status(401).json(null);

    const signatureBuffer = Buffer.from(signature, "utf8");
    const digestBuffer = Buffer.from(digest, "utf8");
    if (signatureBuffer.length !== digestBuffer.length || !crypto.timingSafeEqual(signatureBuffer, digestBuffer)) {
      return res.status(401).json(null);
    }

    const data = JSON.parse(bodyStr);

    // Send HTTP response immediately
    res.sendStatus(200);

    // Run processing asynchronously after returning HTTP success to GitHub
    (async () => {
      try {
        if (await handleInstallationWebhookEvent(event, data)) return;
        if (await handlePushWebhookEvent(event, data)) return;
        if (await handleActionWebhookEvent(event, data)) return;
      } catch (error) {
        console.error("Error in Webhook event processing", { error, event, action: data?.action });
      }
    })();
  } catch (error) {
    console.error("Error processing webhook request:", error);
    res.sendStatus(500);
  }
});

export { router };
