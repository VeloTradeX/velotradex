#!/usr/bin/env node
'use strict';

/**
 * Generate version.json at the repository root.
 *
 * Reads `version` from package.json and the current build timestamp, then
 * writes them to <root>/version.json in the form:
 *   { "version": "1.0.0", "buildTime": "<ISO time>" }
 *
 * version.json is git-ignored and therefore not committed. This script is
 * deliberately fault-tolerant: if reading package.json fails, it falls back
 * to a default version so the build never crashes.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VERSION_FILE = path.join(ROOT, 'version.json');

function readVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    return pkg.version || '0.0.0';
  } catch (err) {
    console.warn(`[generate-version] Failed to read package.json, using default version. (${err.message})`);
    return '0.0.0';
  }
}

const version = readVersion();
const buildTime = new Date().toISOString();
const payload = { version, buildTime };

try {
  fs.writeFileSync(VERSION_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  console.log(`[generate-version] Wrote ${VERSION_FILE} -> ${JSON.stringify(payload)}`);
} catch (err) {
  console.error(`[generate-version] Failed to write ${VERSION_FILE}: ${err.message}`);
  process.exit(1);
}