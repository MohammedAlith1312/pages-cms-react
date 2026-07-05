/**
 * Phase 2 fix script:
 * 1. Copy remaining missing lib files from pagescms to ui/src/lib
 * 2. Fix leftover useRouter() calls → useNavigate()
 * 3. Fix router.refresh() → window.location.reload()
 * 4. Fix useSearchParams() → const [searchParams] = useSearchParams()
 */
const fs = require("fs");
const path = require("path");

// ── 1. Copy missing lib files ────────────────────────────────────────────────
const filesToCopy = [
  { src: "pagescms/lib/authz-shared.ts",    dest: "ui/src/lib/authz-shared.ts" },
  { src: "pagescms/lib/config.ts",          dest: "ui/src/lib/config.ts" },
  { src: "pagescms/lib/templates.ts",       dest: "ui/src/lib/templates.ts" },
  { src: "pagescms/lib/tracker.ts",         dest: "ui/src/lib/tracker.ts" },
  { src: "pagescms/lib/github-app.ts",      dest: "ui/src/lib/github-app.ts" },
  { src: "pagescms/lib/auth-redirect.ts",   dest: "ui/src/lib/auth-redirect.ts" },
  { src: "pagescms/lib/github-auth.ts",     dest: "ui/src/lib/github-auth.ts" },
  { src: "pagescms/lib/serialization.ts",   dest: "ui/src/lib/serialization.ts" },
  { src: "pagescms/lib/operations.ts",      dest: "ui/src/lib/operations.ts" },
  { src: "pagescms/lib/actions.ts",         dest: "ui/src/lib/actions.ts" },
];

// Also copy the actions subdirectory
const actionsDir = "pagescms/lib/actions";
if (fs.existsSync(actionsDir)) {
  const files = fs.readdirSync(actionsDir);
  for (const f of files) {
    filesToCopy.push({
      src: `${actionsDir}/${f}`,
      dest: `ui/src/lib/actions/${f}`,
    });
  }
}

let copied = 0;
for (const { src, dest } of filesToCopy) {
  const srcPath = path.resolve(src);
  const destPath = path.resolve(dest);
  if (fs.existsSync(srcPath)) {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.copyFileSync(srcPath, destPath);
    console.log(`✅ Copied: ${src} → ${dest}`);
    copied++;
  } else {
    console.warn(`⚠️  Missing: ${src}`);
  }
}
console.log(`\nCopied ${copied} files.\n`);

// ── 2. Fix remaining Next.js-isms in ui/src ──────────────────────────────────
const uiSrc = path.resolve("ui/src");

function fixFile(filePath) {
  let content = fs.readFileSync(filePath, "utf8");
  const original = content;

  // router.refresh() → window.location.reload()
  content = content.replace(/router\.refresh\(\)/g, "window.location.reload()");

  // import { useRouter } from "react-router-dom" → import { useNavigate } from "react-router-dom"
  content = content.replace(
    /import\s*\{\s*useRouter\s*\}\s*from\s*["']react-router-dom["']/g,
    `import { useNavigate } from "react-router-dom"`
  );

  // useRouter() → useNavigate()
  content = content.replace(/\buseRouter\(\)/g, "useNavigate()");

  // Fix useSearchParams destructuring: const searchParams = useSearchParams()
  // → const [searchParams] = useSearchParams()
  content = content.replace(
    /const\s+(\w+)\s*=\s*useSearchParams\(\)/g,
    "const [$1] = useSearchParams()"
  );

  if (content !== original) {
    fs.writeFileSync(filePath, content, "utf8");
    console.log(`🔧 Fixed: ${path.relative(process.cwd(), filePath)}`);
  }
}

function walkDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkDir(full);
    else if (/\.(tsx?|jsx?)$/.test(e.name)) fixFile(full);
  }
}

console.log("Fixing remaining Next.js-isms in ui/src...\n");
walkDir(uiSrc);
console.log("\nDone!");
