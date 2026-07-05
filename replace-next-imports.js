/**
 * Replaces Next.js-specific imports/APIs with React Router / Vite equivalents
 * across all .tsx/.ts files in ui/src/.
 */
const fs = require("fs");
const path = require("path");

const targetDir = path.resolve("ui/src");
let totalFiles = 0;

function processFile(filePath) {
  let content = fs.readFileSync(filePath, "utf8");
  const original = content;

  // 1. import Link from "next/link"  →  import { Link } from "react-router-dom"
  content = content.replace(
    /import\s+Link\s+from\s+['"]next\/link['"]/g,
    `import { Link } from "react-router-dom"`
  );

  // 2. <Link href=  →  <Link to=   (only inside JSX, not other elements)
  content = content.replace(/<Link\s+href=/g, "<Link to=");

  // 3. import Image from "next/image"  →  (remove - use plain <img>)
  content = content.replace(
    /import\s+Image\s+from\s+['"]next\/image['"]\s*;\n?/g,
    ""
  );

  // 4. import { useRouter } from "next/navigation"
  //    → import { useNavigate } from "react-router-dom"
  content = content.replace(
    /import\s+\{\s*useRouter\s*\}\s+from\s+['"]next\/navigation['"]/g,
    `import { useNavigate } from "react-router-dom"`
  );

  // 5. const router = useRouter()  →  const router = useNavigate()
  //    router.push(x)              →  router(x)
  content = content.replace(/useRouter\(\)/g, "useNavigate()");
  content = content.replace(/router\.push\(/g, "router(");
  content = content.replace(/router\.replace\(/g, "router(");

  // 6. import { usePathname } from "next/navigation"
  //    → import { useLocation } from "react-router-dom"
  content = content.replace(
    /import\s+\{\s*usePathname\s*\}\s+from\s+['"]next\/navigation['"]/g,
    `import { useLocation } from "react-router-dom"`
  );
  content = content.replace(/usePathname\(\)/g, "useLocation().pathname");

  // 7. import { useSearchParams } from "next/navigation"
  //    → import { useSearchParams } from "react-router-dom"  (same name, compatible API)
  content = content.replace(
    /from\s+['"]next\/navigation['"]/g,
    `from "react-router-dom"`
  );

  // 8. import { redirect } from "next/navigation" → remove (not needed client-side)
  content = content.replace(
    /import\s+\{\s*redirect\s*\}\s+from\s+['"]next\/navigation['"]\s*;\n?/g,
    ""
  );

  // 9. Any remaining next/* imports — warn
  const remainingNext = content.match(/from\s+['"]next\//g);
  if (remainingNext) {
    console.warn(`  ⚠️  Remaining next/ imports in ${filePath}:`, remainingNext);
  }

  if (content !== original) {
    fs.writeFileSync(filePath, content, "utf8");
    console.log(`✅ Updated: ${path.relative(process.cwd(), filePath)}`);
    totalFiles++;
  }
}

function processDir(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      processDir(fullPath);
    } else if (entry.isFile() && /\.(tsx?|jsx?)$/.test(entry.name)) {
      processFile(fullPath);
    }
  }
}

console.log(`\nReplacing Next.js imports in ${targetDir}...\n`);
processDir(targetDir);
console.log(`\nDone! Updated ${totalFiles} file(s).`);
