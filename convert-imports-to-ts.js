const fs = require("fs");
const path = require("path");

const targetDir = path.resolve("api");

function processDirectory(dir) {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      processDirectory(fullPath);
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      let content = fs.readFileSync(fullPath, "utf8");
      
      // Matches relative imports like from "./foo.js" or from "../bar.js"
      const relativeJsImportRegex = /(from\s+['"]\.\.?\/[^'"]+)\.js(['"])/g;
      
      if (relativeJsImportRegex.test(content)) {
        content = content.replace(relativeJsImportRegex, "$1.ts$2");
        fs.writeFileSync(fullPath, content, "utf8");
        console.log(`Updated imports in: ${fullPath}`);
      }
    }
  }
}

console.log(`Converting .js imports to .ts inside ${targetDir}...`);
processDirectory(targetDir);
console.log("Conversion complete!");
