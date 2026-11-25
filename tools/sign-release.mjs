// Signs a release's files so `steer update` can check them. The release workflow runs it:
//   STEER_SIGNING_KEY="<private key pem>" node tools/sign-release.mjs 1.2.3 dist/*
// Next to each file it writes <file>.sig, the hex Ed25519 signature of
// "steer-release v<version> <file name> sha256:<sha256 of the file>". steer checks that
// against the public key built into it (RELEASE_KEY in src/manage.rs) before it installs
// an update, so nobody without the private key can ship a steer that updates go to.

import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const [version, ...files] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? "") || !files.length) {
  console.error("usage: node tools/sign-release.mjs 1.2.3 file...");
  process.exit(2);
}
if (!process.env.STEER_SIGNING_KEY) {
  console.error("STEER_SIGNING_KEY isn't set. An unsigned release can't be installed by steer update, so stopping here.");
  process.exit(1);
}
const key = createPrivateKey(process.env.STEER_SIGNING_KEY);
const pub = createPublicKey(key);
console.log(`signing with key ${pub.export({ type: "spki", format: "der" }).subarray(-32).toString("hex")}`);
for (const file of files.filter((f) => !f.endsWith(".sig"))) {
  const bytes = readFileSync(file);
  const message = Buffer.from(`steer-release v${version} ${basename(file)} sha256:${createHash("sha256").update(bytes).digest("hex")}`);
  const sig = sign(null, message, key);
  if (!verify(null, message, pub, sig)) throw new Error(`the signature for ${file} doesn't check out`);
  writeFileSync(`${file}.sig`, `${sig.toString("hex")}\n`);
  console.log(`signed ${basename(file)}`);
}
