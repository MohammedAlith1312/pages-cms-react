const fs = require("fs");
const path = require("path");

const copies = [
  { from: "pagescms/db/migrations", to: "api/db/migrations" },
  { from: "pagescms/db/scripts", to: "api/db/scripts" },
  { from: "pagescms/components", to: "ui/src/components" },
  { from: "pagescms/contexts", to: "ui/src/contexts" },
  { from: "pagescms/fields", to: "ui/src/fields" },
  { from: "pagescms/public", to: "ui/public" },
  { from: "pagescms/types", to: "ui/src/types" }
];

copies.forEach(({ from, to }) => {
  const fromPath = path.resolve(from);
  const toPath = path.resolve(to);

  if (fs.existsSync(fromPath)) {
    console.log(`Copying from ${fromPath} to ${toPath}...`);
    // Ensure parent directory of target exists
    fs.mkdirSync(path.dirname(toPath), { recursive: true });
    fs.cpSync(fromPath, toPath, { recursive: true, force: true });
  } else {
    console.warn(`Source folder does not exist: ${fromPath}`);
  }
});

console.log("Copying completed successfully.");
