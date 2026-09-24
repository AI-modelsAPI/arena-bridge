#!/usr/bin/env node
// Usage: printf '%s' "$PASSWORD" | node scripts/hash-password.mjs
// Never pass a password on the command line or commit it to the repository.
import fs from 'node:fs';
import { hashPassword } from '../policy.mjs';
const password = fs.readFileSync(0, 'utf8').replace(/\r?\n$/, '');
if (!password) throw new Error('provide the password via stdin');
console.log(hashPassword(password));
