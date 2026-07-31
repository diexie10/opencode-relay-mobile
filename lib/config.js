// lib/config.js — Relay configuration (relay-data/config.json)
const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.resolve(__dirname, '..', 'relay-data', 'config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (e) { /* ignore corrupt config */ }
  return {};
}

function saveConfig(config) {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
}

module.exports = { loadConfig, saveConfig, CONFIG_PATH };
