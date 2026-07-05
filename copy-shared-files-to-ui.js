const fs = require("fs");
const path = require("path");

const filesToCopy = [
  // Types
  { src: "pagescms/types/api.ts", dest: "ui/src/types/api.ts" },
  { src: "pagescms/types/config.ts", dest: "ui/src/types/config.ts" },
  { src: "pagescms/types/field.ts", dest: "ui/src/types/field.ts" },
  { src: "pagescms/types/repo.ts", dest: "ui/src/types/repo.ts" },
  { src: "pagescms/types/user.ts", dest: "ui/src/types/user.ts" },
  { src: "pagescms/types/nodemailer.d.ts", dest: "ui/src/types/nodemailer.d.ts" },
  { src: "pagescms/types/turndown-plugin-gfm.d.ts", dest: "ui/src/types/turndown-plugin-gfm.d.ts" },

  // Libs
  { src: "pagescms/lib/schema.ts", dest: "ui/src/lib/schema.ts" },
  { src: "pagescms/lib/github-image.ts", dest: "ui/src/lib/github-image.ts" },
  { src: "pagescms/lib/api-client.ts", dest: "ui/src/lib/api-client.ts" },
  { src: "pagescms/lib/auth-client.ts", dest: "ui/src/lib/auth-client.ts" },
  { src: "pagescms/lib/actions.ts", dest: "ui/src/lib/actions.ts" },

  // Utils
  { src: "pagescms/lib/utils/file.ts", dest: "ui/src/lib/utils/file.ts" },
  { src: "pagescms/lib/utils/avatar.ts", dest: "ui/src/lib/utils/avatar.ts" }
];

filesToCopy.forEach(({ src, dest }) => {
  const srcPath = path.resolve(src);
  const destPath = path.resolve(dest);

  if (fs.existsSync(srcPath)) {
    const destDir = path.dirname(destPath);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true });
    }
    fs.copyFileSync(srcPath, destPath);
    console.log(`Copied: ${src} -> ${dest}`);
  } else {
    console.warn(`Source not found: ${src}`);
  }
});

console.log("Copy complete!");
