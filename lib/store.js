'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

function dataPath(name) {
  return path.join(DATA_DIR, name);
}

function loadJson(name, fallback) {
  const file = dataPath(name);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

let saveTimers = new Map();

function saveJson(name, data) {
  const file = dataPath(name);
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
    return true;
  } catch (err) {
    console.error('[store] save failed', name, err.message);
    return false;
  }
}

function saveJsonDebounced(name, data, delay = 1500) {
  clearTimeout(saveTimers.get(name));
  const t = setTimeout(() => {
    saveTimers.delete(name);
    saveJson(name, data);
  }, delay);
  saveTimers.set(name, t);
}

function loadJsonl(name) {
  const file = dataPath(name);
  const out = [];
  try {
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        /* пропускаем битые строки */
      }
    }
  } catch {
    /* файла ещё нет */
  }
  return out;
}

function appendJsonl(name, obj) {
  try {
    fs.appendFileSync(dataPath(name), JSON.stringify(obj) + '\n');
  } catch (err) {
    console.error('[store] append failed', name, err.message);
  }
}

module.exports = { DATA_DIR, dataPath, loadJson, saveJson, saveJsonDebounced, loadJsonl, appendJsonl };
