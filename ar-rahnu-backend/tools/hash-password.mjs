import bcrypt from 'bcryptjs';

const pass = process.argv[2];
if (!pass) {
  console.error('Usage: node tools/hash-password.mjs "yourPassword"');
  process.exit(1);
}

const hash = await bcrypt.hash(pass, 10);
console.log(hash);
