// Run once after migration to create the first owner login:
//   node src/db/createOwner.js "Zaira" owner@zairascollection.com "a-strong-password"
require("dotenv").config();
const bcrypt = require("bcryptjs");
const pool = require("./pool");

async function main() {
  const [name, email, password] = process.argv.slice(2);
  if (!name || !email || !password) {
    console.error('Usage: node src/db/createOwner.js "Full Name" email@example.com password');
    process.exit(1);
  }
  const password_hash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    `INSERT INTO users (name, email, password_hash, role)
     VALUES ($1, $2, $3, 'owner')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
     RETURNING id, name, email, role`,
    [name, email.toLowerCase(), password_hash]
  );
  console.log("Owner ready:", rows[0]);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
