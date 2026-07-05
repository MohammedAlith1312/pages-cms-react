const fs = require("fs");
const path = require("path");

const targetDir = path.resolve("ui/src");

function processDirectory(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      processDirectory(fullPath);
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      let content = fs.readFileSync(fullPath, "utf8");
      
      // Matches both "use client"; and "use client" and 'use client' (with optional double/single quotes and semicolons)
      const clientDirectiveRegex = /^[ \t]*(['"]use client['"];?)[ \t]*\r?\n/m;
      const serverDirectiveRegex = /^[ \t]*(['"]use server['"];?)[ \t]*\r?\n/m;
      
      let modified = false;
      
      if (clientDirectiveRegex.test(content)) {
        content = content.replace(clientDirectiveRegex, "");
        modified = true;
      }
      
      if (serverDirectiveRegex.test(content)) {
        content = content.replace(serverDirectiveRegex, "");
        modified = true;
      }
      
      if (modified) {
        fs.writeFileSync(fullPath, content, "utf8");
        console.log(`Cleaned directives from: ${fullPath}`);
      }
    }
  }
}

console.log(`Scanning ${targetDir} for next.js directives...`);
processDirectory(targetDir);
console.log("Cleanup complete!");
