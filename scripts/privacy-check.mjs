#!/usr/bin/env node
// Blocks a commit or a CI run when the repository contains data that looks personal:
// Italian tax codes, IBANs, e-mail addresses, phone numbers, ID-card or passport numbers,
// Google tokens or OAuth secrets. Words listed in MOCHI_PRIVATE_WORDS (one per line or
// separated by commas: real property names, street names, surnames) are blocked too; that
// list lives in a CI secret or in .private-words (git-ignored), never in the repository.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8' })
  .split('\n').filter(Boolean);
const TEXT = /\.(c?js|mjs|py|ps1|psm1|html|css|md|json|txt|ya?ml|toml|gitignore)$/i;
const XLSX = /\.xlsx$/i;

const patterns = [
  ['codice fiscale', /\b[A-Z]{6}\d{2}[A-EHLMPR-T]\d{2}[A-Z]\d{3}[A-Z]\b/],
  ['IBAN', /\bIT\d{2}[A-Z]\d{10}[0-9A-Z]{12}\b/],
  ['e-mail', /\b[A-Za-z0-9._%+-]+@(?!example\.(?:com|org)\b|users\.noreply\.github\.com\b)[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/],
  ['telefono', /(?:\+39|0039)[\s.-]?\d{2,4}[\s.-]?\d{5,8}\b/],
  ['documento (carta d’identità)', /\b(?:C[A-Z]\d{5}[A-Z]{2}|A[A-Z]\d{7})\b/],
  ['token Google', /\bya29\.[0-9A-Za-z_-]{20,}|\b1\/\/[0-9A-Za-z_-]{30,}|GOCSPX-[0-9A-Za-z_-]{20,}/],
  ['ID foglio Google', /docs\.google\.com\/spreadsheets\/d\/[0-9A-Za-z_-]{25,}/],
  ['percorso personale', /[A-Za-z]:\\Users\\(?!Nome\\|<)[^\\\s"']+/],
];

let words = [];
const fromFile = path.join(root, '.private-words');
for (const source of [process.env.MOCHI_PRIVATE_WORDS || '', fs.existsSync(fromFile) ? fs.readFileSync(fromFile, 'utf8') : '']) {
  words.push(...source.split(/[\n,]/).map(w => w.trim()).filter(w => w.length >= 3 && !w.startsWith('#')));
}
const wordPatterns = words.map(w => new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));

function xlsxText(file) {
  // Shared strings and inline strings: enough to find names typed in a spreadsheet.
  try {
    return execFileSync('unzip', ['-p', file], { encoding: 'latin1', maxBuffer: 64 * 1024 * 1024 });
  } catch { return fs.readFileSync(file, 'latin1'); }
}

const problems = [];
for (const rel of files) {
  if (rel === 'scripts/privacy-check.mjs') continue;
  const file = path.join(root, rel);
  if (!fs.existsSync(file) || fs.statSync(file).size > 8 * 1024 * 1024) continue;
  let text;
  if (TEXT.test(rel)) text = fs.readFileSync(file, 'utf8');
  else if (XLSX.test(rel)) text = xlsxText(file);
  else continue;
  for (const [label, re] of patterns) { const m = text.match(re); if (m) problems.push(`${rel}: ${label} (${m[0].slice(0, 6)}…)`); }
  wordPatterns.forEach((re, i) => { if (re.test(text)) problems.push(`${rel}: parola privata n. ${i + 1}`); });
}
if (problems.length) {
  console.error('Possibili dati personali, nulla è stato pubblicato:\n  ' + problems.join('\n  '));
  process.exit(1);
}
console.log(`Controllo privacy superato: ${files.length} file, ${words.length} parole private controllate.`);
