#!/usr/bin/env node
import { fetch } from 'undici';
import { randomUUID } from 'crypto';

const URL = 'http://localhost:9999/payments';
const AMOUNT = 1;
const REQUESTED_AT = '2025-07-27T14:30:00Z';

// Total de requisições e concorrência
const TOTAL = 1000;
const CONCURRENCY = 50;

async function sendPayment() {
  const correlationId = randomUUID();
  const payload = { correlationId, amount: AMOUNT, requestedAt: REQUESTED_AT };

  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  return res.status;
}

async function runBatch(size) {
  // dispara `size` requisições ao mesmo tempo
  return Promise.all(Array.from({ length: size }, () => sendPayment()));
}

async function main() {
  const batches = Math.ceil(TOTAL / CONCURRENCY);
  const summary = {};

  for (let i = 0; i < batches; i++) {
    const batchSize = (i === batches - 1)
      ? TOTAL - i * CONCURRENCY
      : CONCURRENCY;

    const results = await runBatch(batchSize);
    // conta códigos de status
    results.forEach((status) => {
      summary[status] = (summary[status] || 0) + 1;
    });

    console.log(`Batch ${i + 1}/${batches}:`, 
      results.reduce((acc, s) => {
        acc[s] = (acc[s] || 0) + 1; 
        return acc;
      }, {})
    );
  }

  console.log('=== Final summary ===');
  console.table(summary);
}

main().catch((err) => {
  console.error('Error during stress test:', err);
  process.exit(1);
});
