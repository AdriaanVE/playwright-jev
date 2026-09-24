export default {
  provider: { type: "module", module: "./stub-provider.mjs", export: "createProxyStub" },
  cache: { mode: "off" },
  outputDir: "../test-results/playwright-jev",
  snapshotPruning: { minChars: 500, maxRegionChars: 600 },
}
