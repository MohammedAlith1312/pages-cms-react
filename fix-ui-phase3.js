/**
 * Phase 3 fix: Fix remaining issues in ui/src
 * 1. <Link href= → <Link to= (for react-router-dom Links, not email Links)
 * 2. Fix combined usePathname/useRouter imports → useLocation/useNavigate
 * 3. Delete server-side action files from ui/src/lib/actions
 * 4. Copy missing lib files
 */
const fs = require("fs");
const path = require("path");

// ── 1. Copy still-missing lib files ─────────────────────────────────────────
const toCopy = [
  { src: "pagescms/lib/config-schema.ts",  dest: "ui/src/lib/config-schema.ts" },
  { src: "pagescms/lib/config-store.ts",   dest: "ui/src/lib/config-store.ts" },
  { src: "pagescms/lib/github-auth.ts",    dest: "ui/src/lib/github-auth.ts" },
  { src: "pagescms/lib/utils/octokit.ts",  dest: "ui/src/lib/utils/octokit.ts" },
];
for (const { src, dest } of toCopy) {
  const sp = path.resolve(src), dp = path.resolve(dest);
  if (fs.existsSync(sp)) {
    fs.mkdirSync(path.dirname(dp), { recursive: true });
    fs.copyFileSync(sp, dp);
    console.log(`✅ Copied: ${src} → ${dest}`);
  } else {
    console.warn(`⚠️  Missing: ${src}`);
  }
}

// ── 2. Delete server-side action files that must NOT be in ui/ ────────────────
const toDelete = [
  "ui/src/lib/actions/admin.ts",
  "ui/src/lib/actions/collaborator.ts",
  "ui/src/lib/actions/template.ts",
  "ui/src/lib/actions.ts",   // also server-side
];
for (const f of toDelete) {
  const fp = path.resolve(f);
  if (fs.existsSync(fp)) {
    fs.unlinkSync(fp);
    console.log(`🗑  Deleted: ${f}`);
  }
}

// ── 3. Fix remaining import and JSX issues ───────────────────────────────────
const emailDir = path.resolve("ui/src/components/email");

function isEmailFile(filePath) {
  return filePath.startsWith(emailDir);
}

function fixFile(filePath) {
  let content = fs.readFileSync(filePath, "utf8");
  const original = content;

  if (!isEmailFile(filePath)) {
    // Fix <Link href= → <Link to= (only for non-email files)
    content = content.replace(/<Link href=/g, "<Link to=");

    // Fix combined import: import { usePathname, ... } from "react-router-dom"
    // usePathname → useLocation().pathname (replace import)
    // useRouter → useNavigate (replace import)
    content = content.replace(
      /import\s*\{([^}]*)\}\s*from\s*["']react-router-dom["']/g,
      (match, imports) => {
        let fixed = imports
          .replace(/\busePathname\b/g, "useLocation")
          .replace(/\buseRouter\b/g, "useNavigate");
        return `import {${fixed}} from "react-router-dom"`;
      }
    );

    // Fix usages: const pathname = usePathname() → const { pathname } = useLocation()
    content = content.replace(
      /const\s+(\w+)\s*=\s*usePathname\(\)/g,
      "const { pathname: $1 } = useLocation()"
    );

    // usePathname() inline (not assigned)
    content = content.replace(/usePathname\(\)/g, "useLocation().pathname");

    // useRouter() → useNavigate()
    content = content.replace(/\buseRouter\(\)/g, "useNavigate()");
    
    // router.push( → router(
    content = content.replace(/\brouter\.push\(/g, "router(");
    content = content.replace(/\brouter\.replace\(/g, "router(");
    content = content.replace(/\brouter\.refresh\(\)/g, "window.location.reload()");

    // Fix useLocation() used as pathname string directly
    // e.g. const pathname = useLocation() → const { pathname } = useLocation()
    // Already handled above but add useLocation hook import if useLocation is used but not imported
    if (content.includes("useLocation") && !content.includes("useLocation") && !content.includes("from \"react-router-dom\"")) {
      content = `import { useLocation } from "react-router-dom";\n` + content;
    }
  }

  if (content !== original) {
    fs.writeFileSync(filePath, content, "utf8");
    console.log(`🔧 Fixed: ${path.relative(process.cwd(), filePath)}`);
  }
}

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (/\.(tsx?|jsx?)$/.test(entry.name)) fixFile(full);
  }
}

console.log("\nFixing remaining issues in ui/src...\n");
walk(path.resolve("ui/src"));
console.log("\nDone!");
