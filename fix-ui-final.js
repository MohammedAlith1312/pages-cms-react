const fs = require("fs");
const path = require("path");

// 1. Copy required files
const toCopy = [
  { src: "pagescms/lib/api-error.ts", dest: "ui/src/lib/api-error.ts" },
  { src: "pagescms/lib/actions.ts", dest: "ui/src/lib/actions.ts" }
];

for (const { src, dest } of toCopy) {
  const sPath = path.resolve(src);
  const dPath = path.resolve(dest);
  if (fs.existsSync(sPath)) {
    fs.mkdirSync(path.dirname(dPath), { recursive: true });
    fs.copyFileSync(sPath, dPath);
    console.log(`✅ Copied: ${src} -> ${dest}`);
  }
}

// 2. Delete unused config-store.ts from frontend
const unusedFile = path.resolve("ui/src/lib/config-store.ts");
if (fs.existsSync(unusedFile)) {
  fs.unlinkSync(unusedFile);
  console.log(`🗑  Deleted: ui/src/lib/config-store.ts`);
}

// 3. Fix all <Link href= to <Link to= in non-email components
function fixLinkHref(filePath) {
  if (filePath.includes("components" + path.sep + "email")) {
    return; // Skip email templates as they use html-email Link with href
  }
  let content = fs.readFileSync(filePath, "utf8");
  const original = content;

  // Match: <Link ... href={...} ... > or similar
  // We want to replace href= with to= inside <Link ...> tags.
  // To do this reliably, we match `<Link` and then replace any `href=` inside it before it reaches `>`
  content = content.replace(/(<Link\b[^>]*)\bhref=/g, "$1to=");

  if (content !== original) {
    fs.writeFileSync(filePath, content, "utf8");
    console.log(`🔧 Fixed Link in: ${path.relative(process.cwd(), filePath)}`);
  }
}

function walk(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
    } else if (entry.isFile() && /\.(tsx?|jsx?)$/.test(entry.name)) {
      fixLinkHref(fullPath);
    }
  }
}

console.log("\nFixing React Router Link properties in ui/src/components...");
walk(path.resolve("ui/src/components"));
console.log("Done!");
