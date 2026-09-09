import fs from "fs";
import path from "path";

/**
 * Build/çalışma zamanı bağımlılık sınıflandırma testi.
 *
 * GERÇEK VAKA: typescript, prisma, @types/node ve @types/bcryptjs
 * devDependencies'teydi. Railway'in GitHub build'i production modunda
 * (--omit=dev) çalıştığı için bunları atladı ve deploy şu hatayla kırıldı:
 *   sh: 1: tsc: not found  →  exit code 127
 *
 * `railway up` (CLI) çalışıyordu çünkü yerel dosyaları doğrudan yüklüyor —
 * bu yüzden sorun uzun süre fark edilmedi.
 */

const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const lock = JSON.parse(fs.readFileSync(path.join(root, "package-lock.json"), "utf8"));

let pass = 0,
  fail = 0;
function t(name: string, fn: () => void) {
  try {
    fn();
    console.log("PASS:", name);
    pass++;
  } catch (e: any) {
    console.log("FAIL:", name, "-", e.message);
    fail++;
  }
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const deps = pkg.dependencies || {};
const devDeps = pkg.devDependencies || {};

t("build betiğinin ihtiyaç duyduğu paketler dependencies'te", () => {
  // build: "prisma generate && tsc -p tsconfig.json"
  assert("typescript" in deps, "typescript devDependencies'te — production build'de tsc bulunamaz");
  assert("prisma" in deps, "prisma devDependencies'te — production build'de prisma generate çalışmaz");
});

t("start betiğinin ihtiyaç duyduğu paketler dependencies'te", () => {
  // start: "prisma migrate deploy && node dist/server.js"
  assert("prisma" in deps, "prisma dependencies'te değil — start'ta migrate deploy kırılır");
});

t("Derleme için gereken @types paketleri dependencies'te", () => {
  // tsc, tip tanımları olmadan derlemeyi reddeder (TS7016)
  const typePkgs = [...Object.keys(deps), ...Object.keys(devDeps)].filter((p) => p.startsWith("@types/"));
  const misplaced = typePkgs.filter((p) => p in devDeps);
  assert(
    misplaced.length === 0,
    `production build'de eksik kalacak tip paketleri: ${misplaced.join(", ")}`
  );
});

t("package-lock.json dev işaretleri package.json ile tutarlı", () => {
  // KRİTİK: Sadece package.json'ı düzeltmek YETMEZ. Lockfile paketleri hâlâ
  // "dev": true işaretliyse npm --omit=dev onları yine atlar.
  for (const name of Object.keys(deps)) {
    const entry = lock.packages?.[`node_modules/${name}`];
    if (!entry) continue;
    assert(
      entry.dev !== true,
      `${name} dependencies'te ama lockfile'da dev=true — lockfile yenilenmemiş (npm install --package-lock-only)`
    );
  }
});

t("build ve start betikleri beklenen komutları içeriyor", () => {
  // Betikler değişirse yukarıdaki bağımlılık varsayımları geçersiz kalabilir
  assert(/tsc/.test(pkg.scripts.build), "build betiğinde tsc yok");
  assert(/prisma migrate deploy/.test(pkg.scripts.start), "start betiğinde migrate deploy yok");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
