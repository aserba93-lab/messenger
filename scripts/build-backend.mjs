import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

execSync("npx prisma generate", { stdio: "inherit" });

const serverTs = path.join(root, "src", "server.ts");
if (existsSync(serverTs)) {
  execSync("npx tsc -p tsconfig.json", { stdio: "inherit" });
} else {
  // Репозиторий с готовым dist/ без исходников TypeScript (деплой с Git).
  console.log("src/server.ts не найден — пропускаем tsc, используется dist/ из репозитория.");
}
