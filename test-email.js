/**
 * SMTP email dry-run / test.
 *
 * Run: node test-email.js
 *
 * Loads SMTP config from .env via process.env and sends a test email.
 * Safe: never prints SMTP_PASS.
 */

require('dotenv').config();

const { createEmailNotifier } = require('./src/notifiers/emailNotifier');

function validate() {
  const required = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS', 'EMAIL_FROM', 'EMAIL_TO'];
  const missing = required.filter((k) => !process.env[k]);
  return missing;
}

async function main() {
  console.log('📧 Email SMTP Test\n');

  const missing = validate();
  if (missing.length > 0) {
    console.error('❌ Missing required env vars:');
    missing.forEach((k) => console.error(`   - ${k}`));
    console.error('\nPlease set them in .env');
    process.exit(1);
  }

  console.log('SMTP host:', process.env.SMTP_HOST);
  console.log('SMTP port:', process.env.SMTP_PORT || '465');
  console.log('SMTP secure:', process.env.SMTP_SECURE !== 'false' ? 'true' : 'false');
  console.log('SMTP user:', process.env.SMTP_USER);
  console.log('Email from:', process.env.EMAIL_FROM);
  console.log('Recipient:', process.env.EMAIL_TO);
  console.log('SMTP pass: <masked>');
  console.log();

  // createEmailNotifier reads process.env directly — no config object needed
  const notifier = createEmailNotifier();

  // Send a test batch with one mock dead link
  const testBatch = [
    {
      url: 'https://example.com/test',
      consecutiveFailures: 3,
      lastReason: 'Test failure',
      lastFailureAt: new Date().toISOString(),
      finalUrl: null,
      statusCode: null,
    },
  ];

  const testResults = [
    { url: 'https://example.com/test', ok: false, status: 200, reason: 'Test failure', finalUrl: null },
    { url: 'https://example.com/alive', ok: true, status: 200, reason: null, finalUrl: null },
  ];

  console.log('Sending test email...');
  // sendDeadAlert reads process.env directly — no config needed
  const result = await notifier.sendDeadAlert(testBatch, 3, testResults);

  if (result.sent) {
    console.log('\n✅ Email test: PASS');
    console.log('SMTP host:', process.env.SMTP_HOST);
    console.log('SMTP user:', process.env.SMTP_USER);
    console.log('Recipient:', process.env.EMAIL_TO);
    console.log('Password: <masked>');
    process.exit(0);
  } else {
    console.error('\n❌ Email test: FAIL');
    console.error('SMTP host:', process.env.SMTP_HOST);
    console.error('SMTP user:', process.env.SMTP_USER);
    console.error('Recipient:', process.env.EMAIL_TO);
    console.error('Password: <masked>');
    console.error('Error:', result.error);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('Unexpected error:', err.message);
  process.exit(1);
});