#!/usr/bin/env bun

import puppeteer from 'puppeteer';
import { spawnSync } from 'bun';
import { join, resolve } from 'path';
import { parseArgs } from 'bun:util';

/**
 * Lighthouse CLI Runner
 * A CLI tool to run Lighthouse audits using a remote Chrome instance
 */

// Parse command line arguments
const { values } = parseArgs({
  args: Bun.argv.slice(2), // Skip the first two arguments (bun and script path)
  options: {
    url: { type: "string" },
    "output-path": { type: "string", default: "report.json" },
    format: { type: "string", default: "json" },
    "chrome-endpoint": { type: "string", default: "wss://chrome-production-4846.up.railway.app" },
    "categories": { type: "string" },
    help: { type: "boolean", default: false }
  },
  allowPositionals: false
});

// Display help if requested or if no URL is provided
if (values.help || !values.url) {
  console.log(`
  Lighthouse CLI Runner

  Usage:
    bun lighthouse-cli.js --url <url> [options]

  Options:
    --url <url>               URL to audit (required)
    --output-path <path>      Output file path (default: report.json)
    --format <format>         Output format: json, html (default: json)
    --chrome-endpoint <url>   WebSocket endpoint for Chrome (default: wss://chrome-production-4846.up.railway.app)
    --categories <cats>       Comma-separated list of categories to audit (e.g., performance,accessibility)
    --help                    Show this help message
  `);
  process.exit(values.help ? 0 : 1);
}

// Ensure output directory exists
const outputPath = resolve(values["output-path"]);
const outputDir = outputPath.substring(0, outputPath.lastIndexOf('/'));

try {
  if (outputDir && !Bun.file(outputDir).exists()) {
    await Bun.mkdir(outputDir, { recursive: true });
  }
} catch (error) {
  console.error(`Error creating output directory: ${error.message}`);
  process.exit(1);
}

// Main function to run Lighthouse
async function runLighthouse() {
  console.log(`🔍 Running Lighthouse audit on ${values.url}`);
  console.log(`🔗 Connecting to Chrome at ${values["chrome-endpoint"]}`);
  
  try {
    // Connect to the browser
    const browser = await puppeteer.connect({
      
      browserWSEndpoint: 'wss://chrome-production-4846.up.railway.app',
      // browserWSEndpoint: values["chrome-endpoint"],
      ignoreHTTPSErrors: true
    });
    
    // Get browser info
    const version = await browser.version();
    console.log(`🌐 Connected to Chrome version: ${version}`);
    
    // Create a page and get the browser's WS endpoint
    const page = await browser.newPage();
    const wsEndpoint = browser.wsEndpoint();
    
    console.log(`📡 Using WebSocket endpoint: ${wsEndpoint}`);
    
    // Build Lighthouse command arguments
    const lighthouseArgs = [
      values.url,
      `--output=${values.format}`,
      `--output-path=${outputPath}`,
      `--port=9222`,
      '--throttling-method=provided',
      '--chrome-flags=--headless'
    ];
    
    // Add categories if specified
    if (values.categories) {
      lighthouseArgs.push(`--only-categories=${values.categories}`);
    }
    
    // Run Lighthouse using Chrome's debugging protocol
    const lighthousePath = resolve('/usr/local/bin/lighthouse');
    console.log(`🚀 Launching Lighthouse with args: ${lighthouseArgs.join(' ')}`);
    
    const result = spawnSync({
      cmd: [lighthousePath, ...lighthouseArgs],
      env: {
        ...process.env,
        CHROME_WS_ENDPOINT: wsEndpoint,
      },
      stdio: ['inherit', 'pipe', 'pipe']
    });
    
    if (result.exitCode !== 0) {
      console.error(`❌ Lighthouse failed with exit code ${result.exitCode}`);
      console.error(result.stderr.toString());
      process.exit(result.exitCode);
    }
    
    console.log(result.stdout.toString());
    
    // Close the browser
    await browser.close();
    
    // Verify output file exists
    if (!Bun.file(outputPath).exists()) {
      console.error(`❌ Output file was not created at ${outputPath}`);
      process.exit(1);
    }
    
    console.log(`✅ Lighthouse audit complete! Report saved to ${outputPath}`);
    
  } catch (error) {
    console.error(`❌ Error running Lighthouse: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run the program
runLighthouse();
