import "dotenv/config";
import express from "express";
import cors from "cors";
import { toNodeHandler } from "better-auth/node";
import { auth } from "./lib/auth.ts";

import { router as apiRouter } from "./routes.ts";

const app = express();

// Configure CORS to allow the frontend SPA to communicate with this backend.
const frontendUrl = process.env.FRONTEND_URL || "http://localhost:3000";
app.use(
  cors({
    origin: frontendUrl,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Cookie"],
  })
);

// Capture raw body buffer for verification of GitHub webhooks
app.use(express.json({
  verify: (req: any, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true }));

// Better Auth session injector middleware
app.use(async (req: any, res, next) => {
  try {
    const session = await auth.api.getSession({
      headers: req.headers,
    });
    if (session) {
      req.user = session.user;
      req.session = session;
    }
  } catch (err) {
    console.error("Session lookup error:", err);
  }
  next();
});

// Better Auth routes handler
app.all("/api/auth/*", toNodeHandler(auth));

// Mount REST API endpoints
app.use(apiRouter);

// Healthcheck endpoint
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "pagescms-api", timestamp: new Date() });
});

// Root route
app.get("/", (req, res) => {
  res.send("Pages CMS API Server is running.");
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`[API] Server is running on port ${PORT}`);
  console.log(`[API] CORS configured for frontend at ${frontendUrl}`);
});
