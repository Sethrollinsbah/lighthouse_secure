#!/usr/bin/env bun

import puppeteer from 'puppeteer';
import { spawnSync } from 'bun';
import { join, resolve } from 'path';
import { parseArgs } from 'bun:util';
import { existsSync } from 'fs';

/**
 * Lighthouse CLI Runner
 * A CLI tool to run Lighthouse audits using remote or local Chrome
 * with support for processing multiple URLs
 */

// Parse command line arguments
const { values } = parseArgs({
  args: Bun.argv.slice(2), // Skip the first two arguments (bun and script path)
  options: {
    urls: { type: "string" }, // JSON array of URLs
    "url-file": { type: "string" },
    "output-dir": { type: "string", default: "./reports" },
    format: { type: "string", default: "json" },
    "chrome-endpoint": { type: "string" }, // No default, will check if provided
    "categories": { type: "string" },
    "concurrent": { type: "string", default: "3" }, // Number of concurrent audits as string
    help: { type: "boolean", default: false }
  },
  allowPositionals: true
});

// Display help if requested or if no URLs provided
if (values.help || (!values.urls && !values["url-file"])) {
  console.log(`
  Lighthouse CLI Runner

  Usage:
    bun lighthouse-cli.js --urls "['https://example.com', 'https://another-site.com']" [options]
    bun lighthouse-cli.js --url-file urls.txt [options]

  Options:
    --urls <json-array>       JSON array of URLs to audit 
    --url-file <file>         File containing URLs to audit (one URL per line)
    --output-dir <dir>        Output directory for reports (default: ./reports)
    --format <format>         Output format: json, html (default: json)
    --chrome-endpoint <url>   WebSocket endpoint for Chrome (if not specified, local Chrome will be used)
    --categories <cats>       Comma-separated list of categories to audit (e.g., performance,accessibility)
    --concurrent <num>        Number of concurrent audits to run (default: 3)
    --help                    Show this help message

  Examples:
    bun lighthouse-cli.js --urls "['https://fb.com', 'https://google.com']"
    bun lighthouse-cli.js --url-file my-urls.txt --format html
  `);
  process.exit(values.help ? 0 : 1);
}

// Extract URLs from the JSON array in --urls parameter
let urlsToAudit = [];

if (values.urls) {
  try {
    // Parse the JSON string
    const parsedUrls = JSON.parse(values.urls);
    
    // Check if it's an array
    if (Array.isArray(parsedUrls)) {
      urlsToAudit = parsedUrls;
      console.log(`📋 Parsed ${urlsToAudit.length} URLs from command line parameter`);
    } else {
      console.error(`❌ --urls parameter must be a JSON array of strings`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`❌ Error parsing URLs from --urls parameter: ${error.message}`);
    console.error(`   Make sure the format is a valid JSON array: --urls "['url1', 'url2']"`);
    process.exit(1);
  }
}

// Load URLs from file if specified
if (values["url-file"]) {
  try {
    const urlFile = Bun.file(values["url-file"]);
    if (await urlFile.exists()) {
      const content = await urlFile.text();
      const urlsFromFile = content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'));
      
      urlsToAudit = [...urlsToAudit, ...urlsFromFile];
      console.log(`📋 Loaded ${urlsFromFile.length} URLs from ${values["url-file"]}`);
    } else {
      console.error(`❌ URL file not found: ${values["url-file"]}`);
      process.exit(1);
    }
  } catch (error) {
    console.error(`❌ Error reading URL file: ${error.message}`);
    process.exit(1);
  }
}

// Remove duplicates and normalize URLs
urlsToAudit = [...new Set(urlsToAudit)].map(url => {
  // Add https:// if protocol is missing
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return `https://${url}`;
  }
  return url;
});

if (urlsToAudit.length === 0) {
  console.error('❌ No URLs to audit. Please provide URLs via --urls or --url-file.');
  process.exit(1);
}

console.log(`🔍 Found ${urlsToAudit.length} unique URLs to audit.`);

// Ensure output directory exists
const outputDir = resolve(values["output-dir"]);

try {
  // Create directory if it doesn't exist
  if (!existsSync(outputDir)) {
    console.log(`Creating output directory: ${outputDir}`);
    
    // Use Node.js fs APIs for better error handling
    const { mkdirSync, chmodSync } = require('fs');
    
    // Create directory recursively
    mkdirSync(outputDir, { recursive: true });
    
    // Set permissions to ensure we can write to it (755 in octal)
    chmodSync(outputDir, 0o755);
    
    console.log(`✅ Created output directory with write permissions`);
  } else {
    console.log(`Output directory already exists: ${outputDir}`);
    
    // Verify we have write access by creating a test file
    const testFilePath = join(outputDir, '.write_test');
    try {
      const { writeFileSync, unlinkSync } = require('fs');
      writeFileSync(testFilePath, 'test');
      unlinkSync(testFilePath);
      console.log(`✅ Verified write permissions to output directory`);
    } catch (writeError) {
      console.error(`❌ Cannot write to output directory: ${outputDir}`);
      console.error(`   Error: ${writeError.message}`);
      console.error(`   Try running: chmod 755 "${outputDir}"`);
      process.exit(1);
    }
  }
} catch (error) {
  console.error(`❌ Error setting up output directory: ${error.message}`);
  console.error(`   Try manually creating the directory: mkdir -p "${outputDir}"`);
  process.exit(1);
}

// Function to detect if Chrome is installed locally
async function isLocalChromeAvailable() {
  // Common Chrome paths for different platforms
  const chromePaths = {
    linux: [
      '/usr/bin/google-chrome',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium'
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium'
    ],
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
    ]
  };
  
  const platform = process.platform;
  const paths = chromePaths[platform] || [];
  
  for (const path of paths) {
    if (existsSync(path)) {
      return path;
    }
  }
  
  return null;
}

// Function to run Lighthouse for a single URL
async function runLighthouseForUrl(url, wsEndpoint) {
  try {
    console.log(`🔍 Running audit for: ${url}`);
    
    // Create a sanitized filename from the URL
    const sanitizedUrl = url
      .replace(/^https?:\/\//, '')
      .replace(/[^a-zA-Z0-9]/g, '_')
      .substring(0, 100);
    
    const outputPath = resolve(outputDir, `${sanitizedUrl}.${values.format}`);
    
    // Extract the port from the WebSocket endpoint
    // Example endpoint: ws://127.0.0.1:9222/devtools/browser/...
    const portMatch = wsEndpoint.match(/:(\d+)\//);
    const port = portMatch ? portMatch[1] : "9222";
    
    console.log(`🔌 Using Chrome debugging port: ${port}`);
    
    // Build Lighthouse command arguments
    const lighthouseArgs = [
      url,
      `--output=${values.format}`,
      `--output-path=${outputPath}`,
      `--port=${port}`,
      '--throttling-method=provided',
      '--chrome-flags=--headless'
    ];
    
    // Add categories if specified
    if (values.categories) {
      lighthouseArgs.push(`--only-categories=${values.categories}`);
    }
    
    // Run Lighthouse using Chrome's debugging protocol
    const lighthousePath = resolve('/usr/local/bin/lighthouse');
    
    const result = spawnSync({
      cmd: [lighthousePath, ...lighthouseArgs],
      env: {
        ...process.env,
        CHROME_PATH: process.env.CHROME_PATH || "",
        CHROME_WS_ENDPOINT: wsEndpoint,
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    
    if (result.exitCode !== 0) {
      console.error(`❌ Failed: ${url} (${result.exitCode})`);
      console.error(result.stderr.toString());
      return { url, success: false, error: result.stderr.toString() };
    }
    
    // Verify output file exists
    if (!Bun.file(outputPath).exists()) {
      console.error(`❌ Output file not created for: ${url}`);
      return { url, success: false, error: 'Output file not created' };
    }
    
    console.log(`✅ Completed: ${url} -> ${outputPath}`);
    return { url, success: true, outputPath };
    
  } catch (error) {
    console.error(`❌ Error processing ${url}: ${error.message}`);
    return { url, success: false, error: error.message };
  }
}

// Process URLs in chunks to limit concurrency
async function processUrlsInChunks(urls, chunkSize, wsEndpoint) {
  const results = [];
  
  for (let i = 0; i < urls.length; i += chunkSize) {
    const chunk = urls.slice(i, i + chunkSize);
    console.log(`⏳ Processing batch ${Math.floor(i/chunkSize) + 1}/${Math.ceil(urls.length/chunkSize)} (${chunk.length} URLs)`);
    
    const promises = chunk.map(url => runLighthouseForUrl(url, wsEndpoint));
    const batchResults = await Promise.all(promises);
    
    results.push(...batchResults);
  }
  
  return results;
}

// Main function to run Lighthouse audits
async function runLighthouse() {
  const startTime = Date.now();
  console.log(`🚀 Starting Lighthouse audits for ${urlsToAudit.length} URLs`);
  
  let browser;
  
  try {
    let wsEndpoint;
    
    // Check if chrome-endpoint is specified
    if (values["chrome-endpoint"]) {
      console.log(`🔗 Connecting to remote Chrome at ${values["chrome-endpoint"]}`);
      
      // Connect to the remote browser
      browser = await puppeteer.connect({
        browserWSEndpoint: values["chrome-endpoint"],
        ignoreHTTPSErrors: true
      });
      
      wsEndpoint = browser.wsEndpoint();
      console.log(`📡 Using remote WebSocket endpoint: ${wsEndpoint}`);
    } else {
      console.log(`🔍 No Chrome endpoint specified. Launching local Chrome...`);
      
      // Check if Chrome is available locally
      const chromePath = await isLocalChromeAvailable();
      
      if (!chromePath) {
        console.error(`❌ Local Chrome installation not found. Please install Chrome or specify a remote endpoint.`);
        process.exit(1);
      }
      
      console.log(`🌐 Found local Chrome at: ${chromePath}`);
      
      // Set Chrome path for environment
      process.env.CHROME_PATH = chromePath;
      
      // Launch the browser locally with debugging port explicitly set
      browser = await puppeteer.launch({
        executablePath: chromePath,
        headless: "new",
        args: [
          '--no-sandbox', 
          '--disable-setuid-sandbox',
          '--remote-debugging-port=9222',
          '--disable-extensions'
        ]
      });
      
      wsEndpoint = browser.wsEndpoint();
      console.log(`📡 Using local WebSocket endpoint: ${wsEndpoint}`);
    }
    
    // Get browser info
    const version = await browser.version();
    console.log(`🌐 Connected to Chrome version: ${version}`);
    
    // Process URLs with concurrency limit
    const concurrentAudits = parseInt(values.concurrent, 10) || 3;
    console.log(`⚙️ Running audits with ${concurrentAudits} concurrent processes`);
    
    const results = await processUrlsInChunks(urlsToAudit, concurrentAudits, wsEndpoint);
    
    
    // Close the browser when done
    await browser.close();
    
    // Calculate success rate
    const successCount = results.filter(r => r.success).length;
    const failCount = results.length - successCount;
    
    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);
    
    console.log('\n📊 Audit Summary:');
    console.log('------------------------------------------');
    console.log(`Total URLs: ${results.length}`);
    console.log(`Successful: ${successCount}`);
    console.log(`Failed: ${failCount}`);
    console.log(`Duration: ${duration} seconds`);
    console.log(`Output Directory: ${outputDir}`);
    console.log('------------------------------------------');
    
    // If any audits failed, list them
    if (failCount > 0) {
      console.log('\n❌ Failed URLs:');
      results.filter(r => !r.success)
        .forEach(r => console.log(`  • ${r.url} - ${r.error.split('\n')[0]}`));
    }
    
    console.log('\n✅ Lighthouse audits complete!');
    
  } catch (error) {
    console.error(`\n❌ Error running Lighthouse audits: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
  } finally {
    // Ensure browser is closed even if there are errors
    if (browser) {
      try {
        await browser.close();
        console.log('Browser closed successfully');
      } catch (closeError) {
        console.error(`Error closing browser: ${closeError.message}`);
      }
    }
  }
}

// Run the program
runLighthouse();
