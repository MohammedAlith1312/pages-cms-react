import { Router } from "express";

const router = Router();

// Healthcheck endpoint
router.get("/api/health", (req, res) => {
  res.json({ status: "ok", service: "pagescms-api", timestamp: new Date() });
});

// Root route
router.get("/", (req, res) => {
  res.send("Pages CMS API Server is running.");
});

export { router };
