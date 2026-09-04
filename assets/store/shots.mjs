// Renders the Chrome Web Store screenshots (1280x800) from the real extension
// CSS and popup, so the listing matches the actual product.
import puppeteer from "puppeteer";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = [
  { file: "scene.html", out: "01-watch-together.png" },
  { file: "popup-frame.html", out: "02-setup.png" },
  { file: "steps.html", out: "03-how-it-works.png" },
];

const browser = await puppeteer.launch({
  headless: "shell",
  executablePath: process.env.CHROME_BIN,
  args: ["--no-sandbox", "--force-device-scale-factor=1"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });

for (const { file, out } of shots) {
  await page.goto(pathToFileURL(path.join(here, file)).href, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 400));
  await page.screenshot({ path: path.join(here, out), clip: { x: 0, y: 0, width: 1280, height: 800 } });
  console.log("wrote", out);
}

await browser.close();
