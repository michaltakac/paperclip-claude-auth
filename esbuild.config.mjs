import { build, context } from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";

const presets = createPluginBundlerPresets({
  pluginRoot: process.cwd(),
  manifestEntry: "src/manifest.ts",
  workerEntry: "src/worker.ts",
  uiEntry: "src/ui/index.tsx",
  outdir: "dist",
  sourcemap: true,
});

const watch = process.argv.includes("--watch");
const targets = [presets.esbuild.manifest, presets.esbuild.worker, presets.esbuild.ui].filter(Boolean);

for (const options of targets) {
  if (watch) {
    const ctx = await context(options);
    await ctx.watch();
  } else {
    await build(options);
  }
}
console.log(watch ? "[claude-auth] watching" : "[claude-auth] built");
