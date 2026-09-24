import base from "./playwright.config.js"

export default { ...base, testDir: "./failing", outputDir: "../test-results/e2e-failing" }
